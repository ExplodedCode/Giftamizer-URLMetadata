import express, { Response } from 'express';
import bodyParser from 'body-parser';

import { Browser } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import createPuppeteerStealth from 'puppeteer-extra-plugin-stealth';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';

import UserAgent from 'user-agents';

import axios from 'axios';
import sharp from 'sharp';
import UI from './UI';

const puppeteerStealth = createPuppeteerStealth();
puppeteerStealth.enabledEvasions.delete('user-agent-override');
puppeteer.use(puppeteerStealth);
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

class BrowserManager {
	browser: Browser;
	urlQueue: string[] = [];

	constructor() {
		this.launchBrowser();
	}

	async launchBrowser() {
		this.browser = await puppeteer.launch({
			// headless: false,
			headless: 'new',
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1600,1200'],
		});
		console.log('Browser launched');
	}

	async enqueue(url: string, res: Response) {
		this.urlQueue.push(url);

		console.log('Load images for... ' + url);

		// initialize page
		const page = await this.browser.newPage();
		await page.setViewport({
			width: 1600,
			height: 1200,
		});

		if (this.urlQueue.length > 0) {
			const url = this.urlQueue.shift();
			let response: any = {
				url: url,
				images: [],
			};

			// if amazon link
			if (url.startsWith('https://www.amazon.com') || url.startsWith('https://amazon.com') || url.startsWith('https://a.co') || url.startsWith('https://amzn.to')) {
				try {
					await page.goto(url);
					await page.waitForSelector('#productTitle', { timeout: 5000 });

					// get title
					try {
						response.title = (await page.$eval('#productTitle', (element) => element.innerHTML)).trim();
					} catch (e) {}

					// get description
					try {
						response.description = (await page.$eval('#productDescription', (element) => element.innerHTML)).trim();
					} catch (e) {}

					// get price
					try {
						response.price = (await page.$eval('.a-offscreen', (element) => element.innerHTML)).trim();
					} catch (e) {}

					// get images
					try {
						let images = [];
						const imageScriptElement = (await page.$x('//script[contains(., "ImageBlockATF")]/text()'))[0];
						let imageScript = await page.evaluate((el) => el.textContent, imageScriptElement);
						const imageRegex = /\"large\":\"(https.*?\.jpg)\"/gm;
						let m;
						while ((m = imageRegex.exec(imageScript)) !== null) {
							if (m.index === imageRegex.lastIndex) imageRegex.lastIndex++;
							m.forEach((match, groupIndex) => {
								if (groupIndex === 1) {
									images.push(match);
								}
							});
						}
						response.images = images;

						// convert urls to base64 images
						let imagesBase64 = [];
						for (let index = 0; index < response.images.length; index++) {
							const img = response.images[index];
							try {
								imagesBase64.push(await getImageAsBase64(img));
							} catch (e) {}
						}
						response.images = imagesBase64;
					} catch (e) {}

					// get page screenshot
					const screenshot = await page.screenshot({ encoding: 'base64' });
					response.images = response.images.slice(0, 10); // top 10 images
					response.images = response.images.concat('data:image/jpeg;base64,' + screenshot);

					// remove duplicates
					response.images = response.images.filter(function (item: any, pos: number) {
						return response.images?.indexOf(item) == pos;
					});

					// close page
					await page.close();

					console.log(response);
					res.send(response);
				} catch (error) {
					console.log(error);
					res.status(400).send({ error: 'Product not found' });
				}
			} else {
				try {
					await page.goto(url, {
						waitUntil: 'domcontentloaded',
					});

					await delay(1000); // wait for 1000ms

					await autoScroll(page, 10); // set limit to 50 scrolls
					await delay(500); // wait for 500ms
					await page.evaluate(() => {
						// scroll to top
						window.scroll(0, 0);
					});

					// get page title
					try {
						response.title = (await page.$eval('title', (element) => element.innerHTML)).trim();
					} catch (e) {}

					// Fuck walmart
					if (response.title === 'Robot or human?' && url.includes('walmart.com')) {
						throw new Error('Blocked by robot verification');
					}

					// get page description
					try {
						response.description = (await page.$eval('meta[name="description"]', (element) => element.getAttribute('content'))).trim();
					} catch (e) {}

					// get item price
					try {
						const content = await page.$eval('body', (element) => {
							return element.innerText;
						});
						response.price = /\$(\s+?)?\d+(.\d{1,2})/.exec(content)?.[0].replace('$ ', '$');
					} catch (e) {}

					// get first image
					try {
						const img = (await page.$eval('meta[property="og:image"]', (element) => element.getAttribute('content'))).trim();
						if (img.length > 0 && img.startsWith('http')) {
							response.images = [img];
						}
					} catch (e) {}

					try {
						try {
							const imgSrcs = [];
							const imgs = await page.$x('//img[not(ancestor::header)]');
							let index = 0;
							for (let img of imgs) {
								let src = String(await (await img.getProperty('src')).jsonValue());
								if (src.trim().length > 0 && src.startsWith('http') && !src.includes('.svg') && !imgSrcs.includes(src)) {
									if (index > 10) break; // limit images to 10
									imgSrcs.push(src);
									index++;
								}
							}

							response.images = response.images.concat(imgSrcs);
						} catch (e) {}

						// convert urls to base64 images
						let imagesBase64 = [];
						for (let index = 0; index < response.images.length; index++) {
							const img = response.images[index];
							try {
								imagesBase64.push(await getImageAsBase64(img));
							} catch (e) {}
						}
						response.images = imagesBase64;
					} catch (e) {}

					// append page screenshot to the end
					const screenshot = await page.screenshot();
					let resizedImageBuf = await sharp(screenshot);
					// resize if larger than 1000px in any direction
					const metadata = await resizedImageBuf.metadata();
					if (metadata.height > 1000 || metadata.width > 1000) {
						resizedImageBuf = resizedImageBuf.resize(1000);
					}
					// convert to base64
					const base64 = (await resizedImageBuf.toBuffer()).toString('base64');
					response.images = response.images.concat('data:image/jpeg;base64,' + base64);

					// remove duplicates
					response.images = response.images.filter(function (item: any, pos: number) {
						return response.images?.indexOf(item) == pos;
					});

					// close page
					await page.close();

					// console.log(response);
					res.send(response);
				} catch (error) {
					console.log(error);
					res.status(400).send({ error: 'Product not found' });
				}
			}
		}
	}
}

const browserManager = new BrowserManager();

const app = express();
const port = 5500;

// Body Parser Middleware
app.use(bodyParser.json());

app.post('/', async (req, res) => {
	try {
		if (browserManager.browser === undefined) {
			res.status(500).send('Server initializing...');
		} else {
			const url = String(req.body.url).trim();
			if (url.length > 0 && url.startsWith('http')) {
				browserManager.enqueue(url, res);
			} else {
				res.status(400).send({ error: 'No url provided' });
			}
		}
	} catch (error) {
		res.status(500).send('ERROR! - ' + error.message);
	}
});

app.get('/', async (req, res) => {
	try {
		if (browserManager.browser === undefined) {
			res.status(500).send('Server initializing...');
		} else {
			res.send(UI);
		}
	} catch (error) {
		res.status(500).send('ERROR! - ' + error.message);
	}
});

// Display page count every 30 seconds
getPageCount();
setInterval(async () => getPageCount(), 30000);

app.listen(port, () => {
	return console.log(`Express is listening at http://localhost:${port}`);
});

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function getPageCount() {
	if (browserManager.browser !== undefined) {
		const pages = await browserManager.browser.pages();
		console.log(`Active Pages: ${pages.filter((p) => p.url() !== 'about:blank').length}`);
	} else {
		console.log(`Active Pages: 0`);
	}
}

async function autoScroll(page, maxScrolls) {
	await page.evaluate(async (maxScrolls) => {
		await new Promise((resolve) => {
			var totalHeight = 0;
			var distance = 1000;
			var scrolls = 0; // scrolls counter
			var timer = setInterval(() => {
				var scrollHeight = document.body.scrollHeight;
				window.scrollBy(0, distance);
				totalHeight += distance;
				scrolls++; // increment counter

				// stop scrolling if reached the end or the maximum number of scrolls
				if (totalHeight >= scrollHeight - window.innerHeight || scrolls >= maxScrolls) {
					clearInterval(timer);
					resolve(true);
				}
			}, 25);
		});
	}, maxScrolls); // pass maxScrolls to the function
}

async function getImageAsBase64(imageUrl: string): Promise<string> {
	return new Promise(async (resolve, reject) => {
		try {
			const userAgent = new UserAgent({ deviceCategory: 'desktop' });
			const randomUserAgent = userAgent.toString();

			const response = await axios.get(imageUrl, {
				responseType: 'arraybuffer',
				headers: {
					'User-Agent': randomUserAgent,
				},
			});

			// load image and remove transparency
			let resizedImageBuf = await sharp(response.data);
			resizedImageBuf = await resizedImageBuf.flatten({ background: { r: 255, g: 255, b: 255 } });

			// resize if larger than 1000px in any direction
			const metadata = await resizedImageBuf.metadata();
			if (metadata.height > 1000 || metadata.width > 1000) {
				resizedImageBuf = resizedImageBuf.resize(1000);
			}

			// convert to base64
			const base64 = (await resizedImageBuf.toBuffer()).toString('base64');
			resolve(`data:image/jpg;base64,${base64}`);
		} catch (error) {
			console.log(`Error: ${imageUrl}`, error);
			reject(error);
		}
	});
}
