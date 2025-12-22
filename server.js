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
const LOGO_IMG_URL = "https://i.ibb.co/HDvRgqJ0/Banner.jpg";

const slugify = (text) =>
  text.toLowerCase().trim().replace(/\s+/g, "-");

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

async function getPreviewImage(pageUrl) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // common for servers
    });

    const page = await browser.newPage();

    // Optional: extra realism
    // await page.setUserAgent(
    //   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    // );

    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

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
    if (browser) await browser.close();
  }
}


app.post("/upload", upload.single("csv"), async (req, res) => {
  const cars = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (row) => cars.push(row))
    .on("end", async () => {
      let carCards = "";

      for (const car of cars) {
        const make = slugify(car.Make);
        const model = slugify(car.Model);
        const stock = car["Stock Number"];

        const link = `${BASE_URL}/${make}/${model}/${stock}/`;
        const image = await getPreviewImage(link);
        console.log("IMAGE PICKED:", stock, image);


        carCards += `
        <td width="50%" style="padding:10px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:8px;">
            <tr>
              <td align="center" style="padding:10px 15px 6px 15px;">
                <a href="${link}">
                  <img src="${image}" width="240" height="180" style="display:block;border-radius:6px;">
                </a>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:10px;">
                <p style="margin:0; font-size:14px; font-weight:bold; line-height:18px; width:240px; max-width:240px;">
                  ${car.Year} ${car.Make} ${car.Model} ${car.Trim}
                </p>
                <p style="margin:4px 0;font-size:13px;color:#777;">
                  ${formatMileage(car.Odometer)} miles
                </p>
                <p style="margin:6px 0 4px 0;font-size:22px;line-height:24px;font-weight:bold;">
                  ${formatPrice(car["Asking Price"])}
                </p>
                <a href="${link}" style="display:inline-block;margin-top:8px;padding:10px 16px;background:#33383C;color:#ffffff;text-decoration:none;border-radius:20px;font-size:13px;font-weight:bold;letter-spacing:0.2px;box-shadow:0 2px 6px rgba(0,0,0,0.15);">
                  View in Inventory
                </a>
              </td>
            </tr>
          </table>
        </td>
        `;

        if (cars.indexOf(car) % 2 === 1) {
          carCards += "</tr><tr>";
        }
      }

      const emailHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>New Inventory</title>
</head>

<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
  <tr>
    <td align="center">

      <!-- MAIN EMAIL CONTAINER -->
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;margin:20px 0;">

        <!-- HEADER -->
        <tr>
          <td align="center" style="padding:30px 20px;background-color:#33383C;">
            <img src="${LOGO_IMG_URL}"
                 width="320"
                 height="50"
                 alt="Dealership Logo"
                 style="display:block;margin:0 auto 15px auto;">
            <h1 style="margin:0;font-size:32px;letter-spacing:1px;color:#ffffff;">
              NEW INVENTORY
            </h1>
          </td>
        </tr>

        <!-- INTRO TEXT -->
        <tr>
          <td align="center" style="padding:25px 20px;">
            <p style="margin:0;font-size:16px;color:#555555;">
              Fresh arrivals just landed on our lot — take a look and find your next ride today.
            </p>
          </td>
        </tr>

        <!-- INVENTORY GRID -->
        <tr>
          <td style="padding:10px 20px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                ${carCards}
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:10px 20px;">
            <a href="${BASE_URL}"
               style="display:block;width:80%;max-width:360px;margin:0 auto;padding:14px 16px;background:#33383C;color:#ffffff;text-decoration:none;border-radius:20px;font-size:14px;font-weight:bold;letter-spacing:0.2px;box-shadow:0 2px 6px rgba(0,0,0,0.15);text-align:center;">
              Browse Full Inventory
            </a>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="padding:30px 20px;background-color:#33383C;">
            <p style="margin:0 0 10px;font-size:14px;color:#ffffff;">
              📞 <strong>(402) 933-2277</strong> &nbsp;|&nbsp; ✉ <strong>tjkautollc@gmail.com</strong>
            </p>
            <p style="margin:0 0 10px;font-size:13px;color:#cccccc;">
              📍 14227 S St., Omaha, NE 68137
            </p>
            <p style="margin:0;font-size:14px;color:#ffffff;">
              We’re here to make your car-buying experience easy, exciting, and stress-free.  
              Come see what just rolled in — your next drive is waiting 🚗
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

      fs.unlinkSync(req.file.path);
      res.send(emailHTML);
    });
});

app.listen(3000, () =>
  console.log("Running at http://localhost:3000")
);
