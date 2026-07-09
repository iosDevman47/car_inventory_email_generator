import express from "express";
import multer from "multer";
import fs from "fs";
import csv from "csv-parser";
import axios from "axios";
import * as cheerio from "cheerio";
import path from "path";
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.static("public"));

const BASE_URL = "https://www.tjkautollc.com/inventory";
const FALLBACK_IMAGE = "https://www.tjkautollc.com/images/no-image.jpg";
const LOGO_IMG_URL = "https://dcdws.blob.core.windows.net/dws-9213801-113899-media/sites/113899/2026/05/cropped-Frame-76.png";

// --- Brand design tokens (mirrored from styles.css) ---
const BRAND = {
  slate: "#33383C",
  nearBlack: "#0A0A0A",
  ink: "#15171A",
  muted: "#525860",
  line: "#E4E5E7",
  lineStrong: "#D2D4D7",
  offWhite: "#F5F5F5",
  paper: "#FAFAFA",
  white: "#FFFFFF",
};
// Web-safe font stacks. Michroma/Montserrat load in clients that honor
// @import (Apple Mail, iOS); everything else falls back gracefully.
const FONT_DISPLAY = "'Michroma','Helvetica Neue',Arial,sans-serif";
const FONT_UI = "'Montserrat','Helvetica Neue',Arial,sans-serif";

const progressMap = {};
const IMAGE_CONCURRENCY = 4;

const slugify = (text) =>
  text.toLowerCase().trim().replace(/\s+/g, "-");

const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let index = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    const launch = () => {
      if (index >= items.length) {
        if (active === 0) resolve(results);
        return;
      }
      const current = index++;
      active++;
      Promise.resolve(worker(items[current], current))
        .then((res) => {
          results[current] = res;
          active--;
          launch();
        })
        .catch(reject);
    };
    for (let i = 0; i < Math.min(limit, items.length); i++) launch();
  });
};

const formatMileage = (raw) => {
  const numeric = parseInt(String(raw).replace(/[^0-9]/g, ""), 10);
  if (Number.isNaN(numeric)) return raw;
  return new Intl.NumberFormat("en-US").format(numeric);
};

const formatPrice = (raw) => {
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  const numeric = parseFloat(cleaned);
  if (Number.isNaN(numeric)) return raw;

  const formattedNumber = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(numeric);

  return `$${formattedNumber}`;
};

const PAGE_TIMEOUT = 60000;

async function createBrowser() {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'], // common for servers
  });
}

async function getPreviewImage(pageUrl, browser) {

  console.log("URL:", pageUrl);

  let page;
  try {
    page = await browser.newPage();

    // Optional: extra realism
    // await page.setUserAgent(
    //   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    // );

    page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    const img = await page.evaluate(() => {
      return (
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector('meta[property="og:image:secure_url"]')?.content ||
        document.querySelector('meta[name="twitter:image"]')?.content ||
        null
      );
    });

    return img || FALLBACK_IMAGE;
  } catch (err) {
    console.error('Preview image fetch error (Puppeteer):', pageUrl, err.message);
    return FALLBACK_IMAGE;
  } finally {
    if (page) await page.close();
  }
}


app.post("/upload", upload.single("csv"), async (req, res) => {
  const cars = [];
  const jobId = req.body?.jobId;
  let aborted = false;

  const cleanUpload = () => {
    try {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (err) {
      console.error("Upload cleanup error:", err.message);
    }
  };

  req.on("aborted", () => {
    aborted = true;
    cleanUpload();
    if (jobId) delete progressMap[jobId];
  });

  res.on("close", () => {
    if (res.writableEnded) return;
    aborted = true;
    cleanUpload();
    if (jobId) delete progressMap[jobId];
  });

  const stream = fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (row) => cars.push(row))
    .on("end", async () => {
      if (aborted) return;
      let carCards = "";

      if (jobId) {
        progressMap[jobId] = { total: cars.length, completed: 0, done: false };
      }

      let browser;
      try {
        browser = await createBrowser();

        const carCardsArr = await mapWithConcurrency(
          cars,
          IMAGE_CONCURRENCY,
          async (car, idx) => {
            if (aborted) return "";
            const make = slugify(car.Make);
            const model = slugify(car.Model);
            const stock = car["StockNumber"];

            const link = `${BASE_URL}/${make}/${model}/${stock}/`;
            const image = await getPreviewImage(link, browser);
            console.log("IMAGE PICKED:", stock, image);

            if (jobId && progressMap[jobId]) {
              progressMap[jobId].completed = Math.min(
                progressMap[jobId].completed + 1,
                progressMap[jobId].total
              );
            }

            const title = `${car.Year} ${car.Make} ${car.Model} ${car.Trim}`.trim();

            // Brand-aligned vehicle card (mirrors .card in styles.css):
            // media → title → meta → hairline → price / VIEW. A fixed-width
            // inline-block <div> so pairs sit two-up (with text-align:center on
            // the container doing the centering) and stack cleanly on mobile.
            const card = `
            <div class="card" style="display:inline-block;vertical-align:top;box-sizing:border-box;width:100%;max-width:276px;padding:0 8px 20px;font-family:${FONT_UI};text-align:left;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid ${BRAND.line};border-collapse:separate;border-radius:8px;overflow:hidden;background-color:${BRAND.white};">
                <tr>
                  <td style="padding:0;line-height:0;background-color:${BRAND.offWhite};">
                    <a href="${link}" style="text-decoration:none;">
                      <img src="${image}" alt="${title}" width="260" style="display:block;width:100%;height:auto;border:0;">
                    </a>
                  </td>
                </tr>
                <tr>
                  <td style="padding:18px 18px 16px 18px;">
                    <a href="${link}" style="display:block;margin:0;font-family:${FONT_UI};font-size:16px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;color:${BRAND.ink};text-decoration:none;">
                      ${title}
                    </a>
                    <p style="margin:8px 0 0 0;font-family:${FONT_UI};font-size:12px;font-weight:500;letter-spacing:0.02em;color:${BRAND.muted};">
                      ${car.Year}&nbsp;&nbsp;&bull;&nbsp;&nbsp;${formatMileage(car.Odometer)} mi
                    </p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;border-top:1px solid ${BRAND.line};">
                      <tr>
                        <td align="left" style="padding-top:14px;font-family:${FONT_UI};font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${BRAND.slate};white-space:nowrap;">
                          ${formatPrice(car["AskingPrice"])}
                        </td>
                        <td align="right" valign="bottom" style="padding-top:14px;">
                          <a href="${link}" style="font-family:${FONT_UI};font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:${BRAND.muted};text-decoration:none;white-space:nowrap;">
                            View&nbsp;&rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </div>
            `;

            return card;
          }
        );

        if (aborted) return;
        // Chunk cards into rows of two. Robust to odd counts and empty (aborted)
        // slots, and wrapped in Outlook "ghost tables" so the two-up layout
        // holds in Outlook (which ignores inline-block).
        const cards = carCardsArr.filter(Boolean);
        const rows = [];
        for (let i = 0; i < cards.length; i += 2) {
          const left = cards[i];
          const right = cards[i + 1];
          rows.push(`
            <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" align="center" style="width:560px;"><tr><td valign="top" width="280" style="padding:0;"><![endif]-->
            ${left}
            <!--[if mso]></td>${right ? '<td valign="top" width="280" style="padding:0;">' : '<td width="280">'}<![endif]-->
            ${right || ""}
            <!--[if mso]></td></tr></table><![endif]-->
          `);
        }
        carCards = rows.join("");
      } catch (err) {
        if (aborted) return;
        console.error("Error building car cards:", err);
        cleanUpload();
        if (jobId) delete progressMap[jobId];
        return res.status(500).send("Failed to build email");
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch (err) {
            console.error("Browser close error:", err.message);
          }
        }
      }

      const emailHTML = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>New Inventory</title>
  <!--[if mso]>
  <style type="text/css">table,td{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;} img{-ms-interpolation-mode:bicubic;} .display,.h1,.btn{font-family:'Helvetica Neue',Arial,sans-serif!important;}</style>
  <![endif]-->
  <!--[if !mso]><!-->
  <style type="text/css">
    @import url('https://fonts.googleapis.com/css2?family=Michroma&family=Montserrat:wght@400;500;600;700&display=swap');
  </style>
  <!--<![endif]-->
  <style type="text/css">
    body{margin:0;padding:0;width:100%!important;}
    img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
    a{text-decoration:none;}
    @media only screen and (max-width:480px){
      .container{width:100%!important;}
      .card{max-width:100%!important;width:100%!important;padding-left:0!important;padding-right:0!important;}
      .h1{font-size:24px!important;}
      .px{padding-left:16px!important;padding-right:16px!important;}
    }
  </style>
</head>

<body style="margin:0;padding:0;background-color:${BRAND.offWhite};font-family:${FONT_UI};">

<!-- PREHEADER (hidden inbox preview line) -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.offWhite};opacity:0;">
  Fresh arrivals just landed at TJK Auto — see this week's new inventory.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.offWhite};">
  <tr>
    <td align="center" style="padding:24px 10px;">

      <!-- MAIN EMAIL CONTAINER -->
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:${BRAND.white};border:1px solid ${BRAND.line};border-radius:10px;overflow:hidden;">

        <!-- HEADER (banner) -->
        <tr>
          <td align="center" class="px" style="padding:34px 24px 30px 24px;background-color:${BRAND.slate};">
            <img src="${LOGO_IMG_URL}"
                 width="300"
                 alt="TJK Auto LLC"
                 style="display:block;width:100%;max-width:300px;height:auto;margin:0 auto 18px auto;">
            <div style="display:inline-block;border-top:1px solid rgba(255,255,255,0.18);padding-top:16px;">
              <h1 class="h1 display" style="margin:0;font-family:${FONT_DISPLAY};font-size:30px;font-weight:700;letter-spacing:0.12em;color:#ffffff;">
                NEW&nbsp;INVENTORY
              </h1>
            </div>
          </td>
        </tr>

        <!-- INTRO TEXT -->
        <tr>
          <td align="center" class="px" style="padding:30px 32px 14px 32px;">
            <p style="margin:0 0 8px 0;font-family:${FONT_UI};font-size:11px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND.muted};">
              Just Arrived
            </p>
            <p style="margin:0;font-family:${FONT_UI};font-size:16px;line-height:1.6;color:${BRAND.muted};">
              Fresh arrivals just landed on our lot &mdash; take a look and find your next ride today.
            </p>
          </td>
        </tr>

        <!-- INVENTORY GRID -->
        <tr>
          <td align="center" class="px" style="padding:14px 12px 6px 12px;font-size:0;text-align:center;">
            ${carCards}
          </td>
        </tr>

        <!-- BROWSE ALL BUTTON -->
        <tr>
          <td align="center" class="px" style="padding:14px 20px 36px 20px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
              <tr>
                <td align="center" bgcolor="${BRAND.slate}" style="border-radius:4px;">
                  <a href="${BASE_URL}" class="btn" style="display:inline-block;padding:15px 34px;font-family:${FONT_UI};font-size:12px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#ffffff;text-decoration:none;border-radius:4px;">
                    Browse Full Inventory
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td class="px" style="padding:34px 32px;background-color:${BRAND.nearBlack};">
            <p style="margin:0 0 14px 0;font-family:${FONT_DISPLAY};font-size:13px;letter-spacing:0.14em;color:#ffffff;">
              TJK&nbsp;AUTO&nbsp;LLC
            </p>
            <p style="margin:0 0 6px 0;font-family:${FONT_UI};font-size:14px;line-height:1.6;color:rgba(255,255,255,0.82);">
              Phone: <strong style="color:#ffffff;">(402) 933-2277</strong>&nbsp;&nbsp;&middot;&nbsp;&nbsp;Email: <strong style="color:#ffffff;">tjkautollc@gmail.com</strong>
            </p>
            <p style="margin:0 0 16px 0;font-family:${FONT_UI};font-size:13px;line-height:1.6;color:rgba(255,255,255,0.6);">
              14227 S St., Omaha, NE 68137
            </p>
            <p style="margin:0 0 16px 0;font-family:${FONT_UI};font-size:14px;line-height:1.6;color:rgba(255,255,255,0.82);">
              We&rsquo;re here to make your car-buying experience easy, exciting, and stress-free.
              Come see what just rolled in &mdash; your next drive is waiting.
            </p>
            <p style="margin:0;font-family:${FONT_UI};font-size:12px;line-height:1.6;color:rgba(255,255,255,0.45);">
              You received this email because you expressed interest in TJK Auto LLC.
            </p>
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>

</body>
</html>
`;

      cleanUpload();
      if (jobId && progressMap[jobId]) {
        progressMap[jobId].done = true;
        setTimeout(() => delete progressMap[jobId], 5 * 60 * 1000);
      }
      if (!aborted) {
        res.send(emailHTML);
      }
    });
});

app.get("/progress/:jobId", (req, res) => {
  const job = progressMap[req.params.jobId];
  if (!job) return res.json({ status: "unknown" });
  res.json({ status: "ok", ...job });
});

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
