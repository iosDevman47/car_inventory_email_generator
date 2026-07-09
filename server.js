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
            const stock = car["Stock Number"];

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

            // Self-contained fluid-hybrid card: an inline-block <div> that sits
            // two-per-row on wide screens and naturally stacks on narrow ones.
            const card = `
            <div class="card" style="display:inline-block;vertical-align:top;box-sizing:border-box;width:100%;max-width:290px;padding:0 10px 20px;font-family:Arial,Helvetica,sans-serif;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e0e0e0;border-collapse:separate;border-radius:8px;">
                <tr>
                  <td align="center" style="padding:10px 15px 6px 15px;">
                    <a href="${link}" style="text-decoration:none;">
                      <img src="${image}" alt="${title}" width="250" style="display:block;width:100%;max-width:250px;height:auto;border:0;border-radius:6px;">
                    </a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:10px;">
                    <p style="margin:0;font-size:14px;font-weight:bold;line-height:18px;color:#222222;">
                      ${title}
                    </p>
                    <p style="margin:4px 0;font-size:13px;color:#777777;">
                      ${formatMileage(car.Odometer)} miles
                    </p>
                    <p style="margin:6px 0 4px 0;font-size:22px;line-height:24px;font-weight:bold;color:#222222;">
                      ${formatPrice(car["Asking Price"])}
                    </p>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:8px auto 0;">
                      <tr>
                        <td align="center" bgcolor="#33383C" style="border-radius:20px;">
                          <a href="${link}" style="display:inline-block;padding:10px 18px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:0.2px;color:#ffffff;text-decoration:none;border-radius:20px;">
                            View in Inventory
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
            <!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" width="50%" style="padding:10px;"><![endif]-->
            ${left}
            <!--[if mso]></td>${right ? '<td valign="top" width="50%" style="padding:10px;">' : '<td width="50%">'}<![endif]-->
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
  <style type="text/css">table,td{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;} img{-ms-interpolation-mode:bicubic;}</style>
  <![endif]-->
  <style type="text/css">
    body{margin:0;padding:0;width:100%!important;}
    img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
    a{text-decoration:none;}
    @media only screen and (max-width:480px){
      .container{width:100%!important;}
      .card{max-width:100%!important;width:100%!important;}
      .h1{font-size:26px!important;}
      .px{padding-left:16px!important;padding-right:16px!important;}
    }
  </style>
</head>

<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">

<!-- PREHEADER (hidden inbox preview line) -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f4f4;opacity:0;">
  Fresh arrivals just landed at TJK Auto — see this week's new inventory.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f4;">
  <tr>
    <td align="center" style="padding:20px 10px;">

      <!-- MAIN EMAIL CONTAINER -->
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;">

        <!-- HEADER -->
        <tr>
          <td align="center" class="px" style="padding:30px 20px;background-color:#33383C;">
            <img src="${LOGO_IMG_URL}"
                 width="320"
                 alt="TJK Auto LLC"
                 style="display:block;width:100%;max-width:320px;height:auto;margin:0 auto 15px auto;">
            <h1 class="h1" style="margin:0;font-size:32px;letter-spacing:1px;color:#ffffff;">
              NEW INVENTORY
            </h1>
          </td>
        </tr>

        <!-- INTRO TEXT -->
        <tr>
          <td align="center" class="px" style="padding:25px 20px;">
            <p style="margin:0;font-size:16px;line-height:22px;color:#555555;">
              Fresh arrivals just landed on our lot &mdash; take a look and find your next ride today.
            </p>
          </td>
        </tr>

        <!-- INVENTORY GRID -->
        <tr>
          <td align="center" class="px" style="padding:10px 10px;font-size:0;">
            ${carCards}
          </td>
        </tr>

        <!-- BROWSE ALL BUTTON -->
        <tr>
          <td align="center" class="px" style="padding:10px 20px 30px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
              <tr>
                <td align="center" bgcolor="#33383C" style="border-radius:24px;">
                  <a href="${BASE_URL}" style="display:inline-block;padding:14px 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;letter-spacing:0.2px;color:#ffffff;text-decoration:none;border-radius:24px;">
                    Browse Full Inventory
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td class="px" style="padding:30px 20px;background-color:#33383C;">
            <p style="margin:0 0 10px;font-size:14px;line-height:20px;color:#ffffff;">
              Phone: <strong>(402) 933-2277</strong>&nbsp;&nbsp;|&nbsp;&nbsp;Email: <strong>tjkautollc@gmail.com</strong>
            </p>
            <p style="margin:0 0 10px;font-size:13px;line-height:20px;color:#cccccc;">
              TJK Auto LLC &middot; 14227 S St., Omaha, NE 68137
            </p>
            <p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#ffffff;">
              We&rsquo;re here to make your car-buying experience easy, exciting, and stress-free.
              Come see what just rolled in &mdash; your next drive is waiting.
            </p>
            <p style="margin:0;font-size:12px;line-height:18px;color:#aaaaaa;">
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
