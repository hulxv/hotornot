/**
 * @typedef {{ title: string, query: string, body: string, caption: string, link?: { text: string, href: string } }} Chapter
 */

/**
 * The "Tell me the story" tour, in the wording the user approved. `body` is the step's text and
 * `caption` the bold one-line takeaway. `query` is the page state in
 * url-state.js's URL form.
 * @type {readonly Readonly<Chapter>[]}
 */
export const CHAPTERS = Object.freeze([
  {
    title: "A satellite goes quiet",
    query: "?region=nile_delta",
    body:
      "On the 2nd of November 2026, the S-NPP satellite sent its last fire data. For fourteen years it was one of our eyes on fires from space. Satellites come and go, but the question stays the same: is this place burning more than usual?",
    caption: "2 Nov 2026: S-NPP's fire data stops. Satellites change; the question doesn't.",
  },
  {
    title: "The fake explosion",
    query: "?region=california&view=raw",
    body:
      "NASA has counted fires from space since 2000 with an instrument called MODIS. In 2012 a sharper one, VIIRS, joined it. VIIRS sees fires as small as a burning field, so it counts three to ten times more fires than MODIS over the same ground. Put the two records end to end, and fires seem to explode in 2012, even though nothing changed on the ground.",
    caption: 'VIIRS counts 3–10× more fires than MODIS. Joined naively, fires "explode" in 2012.',
  },
  {
    title: "One scale",
    query: "?region=california",
    body:
      "Hot or Not puts both on one scale. For every fire VIIRS sees, we ask: how likely is it that MODIS would have seen it too? A big, hot fire counts for more; a small one counts for less. We tested this on years the method had never seen: its yearly totals land on average within 3 to 11 percent of MODIS, depending on the region. Raw VIIRS was off by up to ten times.",
    caption: "Each VIIRS fire counts as much as MODIS would have seen. Tested on unseen years: 3–11% average error.",
    link: { text: "See the test", href: "/method.html#seam" },
  },
  {
    title: "Black Summer",
    query: "?region=se_australia&view=anomaly&to=2019-12",
    body:
      "With one record from 2000 to today, history jumps out. December 2019, south-east Australia: 43,732 fire detections. A normal December has about 530. That is 82 times normal: the Black Summer.",
    caption: "Dec 2019, south-east Australia: 82× a normal December.",
  },
  {
    title: "California 2020",
    query: "?region=california&to=2020-09",
    body: "September 2020, California: eighteen times a normal September, and the busiest month in our 26-year record.",
    caption: "Sep 2020, California: 18× normal.",
  },
  {
    title: "The black cloud",
    query: "?region=nile_delta",
    body:
      "And closer to home. Every autumn, rice straw burned across the Nile Delta, and Cairo knew it as the black cloud. From 2003 to 2016 the Delta averaged about 500 autumn fire detections a year. Since 2017 it has averaged about 215, less than half.",
    caption: "Nile Delta autumn burning: about 500 a year (2003–16), about 215 a year (2017–25).",
  },
  {
    title: "Hot or not, today?",
    query: "?region=california",
    body:
      "With S-NPP gone, its twin NOAA-20 carries on, and we checked that the two agree within 3 percent. So this month is counted on the same scale as the year 2000. California, November 2026 so far: HOT, the fourth busiest of 24 years. The Nile Delta: normal. Hot or Not keeps a 26-year fire record honest while the satellites change. Pick a place and ask: hot, or not?",
    caption: "Today, on the same scale as 2000. Pick a place and ask: hot, or not?",
  },
]);
