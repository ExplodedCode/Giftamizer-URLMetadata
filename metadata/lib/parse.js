const cheerio = require('cheerio')
const MetadataFields = require('./metadata-fields')
const extractMetaTags = require('./extract-meta-tags')
const extractJsonLd = require('./extract-json-ld')

module.exports = function (url, body, options) {
  const $ = cheerio.load(body)
  const scrapedMetaTags = extractMetaTags($)
  const scrapedJsonLd = extractJsonLd($)
  const metadata = new MetadataFields(options)
    .configureType(scrapedMetaTags['og:type'])
    .lockKeys()
    .set(scrapedMetaTags)
    .set({ url })
    .set({ jsonld: scrapedJsonLd })

  // derive canonical url
  if (!metadata.get('canonical')) {
    $('link').each(function (index, el) {
      if (el.attribs && el.attribs.rel === 'canonical' && el.attribs.href) {
        metadata.set({ canonical: el.attribs.href })
      }
    })
  }

  // attach body as string if option is true
  if (options.includeResponseBody) {
    metadata.set({ responseBody: body })
  }

  // clean up and return all metadata fields
  return metadata.clean()
}