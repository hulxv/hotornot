import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCount, ordinal, verdict, verdictMonth, verdictNotes, verdictPeriod, verdictSentence, verdictWord } from "../public/js/verdict.js";

/** The task's example: California, the first 13 days of November 2026. */
const california = { year: 2026, month: 11, days_covered: 13, value: 397.2837, median: 282, rank: 6, of_years: 24, provisional: true, partial_coverage: false };

/** A toy month: value and median chosen to agree with the rank unless a test says otherwise. */
const month = (rank, of_years, extra = {}) => {
  const median = 100;
  const value = rank <= of_years / 2 ? 150 : 50;
  return { year: 2020, month: 9, value, median, rank, of_years, provisional: false, partial_coverage: false, ...extra };
};

describe("verdictWord", () => {
  it("calls the top quarter HOT, the bottom quarter NOT and the rest NORMAL", () => {
    const words = Array.from({ length: 24 }, (_, i) => verdictWord(month(i + 1, 24)));
    assert.deepEqual(words.slice(0, 6), Array(6).fill("HOT"));
    assert.deepEqual(words.slice(6, 18), Array(12).fill("NORMAL"));
    assert.deepEqual(words.slice(18), Array(6).fill("NOT"));
  });

  it("keeps the quarters even when the years do not divide by four", () => {
    assert.deepEqual([1, 2, 3, 4, 5].map((rank) => verdictWord(month(rank, 5))), ["HOT", "NORMAL", "NORMAL", "NORMAL", "NOT"]);
    assert.deepEqual([1, 2, 3, 4].map((rank) => verdictWord(month(rank, 4))), ["HOT", "NORMAL", "NORMAL", "NOT"]);
    const of23 = Array.from({ length: 23 }, (_, i) => verdictWord(month(i + 1, 23)));
    assert.equal(of23.filter((word) => word === "HOT").length, 5);
    assert.equal(of23.filter((word) => word === "NOT").length, 5);
  });

  it("gives no word with fewer than four years or a missing number", () => {
    for (const years of [1, 2, 3]) assert.equal(verdictWord(month(1, years)), null, `${years} years`);
    assert.equal(verdictWord(month(1, 24, { rank: null, of_years: null })), null, "before the ranking starts");
    assert.equal(verdictWord(month(1, 24, { median: null })), null);
    assert.equal(verdictWord(month(1, 24, { value: null })), null);
  });

  it("does not call ties at the usual level HOT or NOT", () => {
    // Every year had zero fires: all tie for 1st, and nothing is unusual.
    assert.equal(verdictWord({ value: 0, median: 0, rank: 1, of_years: 24 }), "NORMAL");
    // Zero fires, tied with 20 other quiet years; three years had fires, so the tie shares 4th.
    assert.equal(verdictWord({ value: 0, median: 0, rank: 4, of_years: 24 }), "NORMAL");
    // A top-quarter rank that only equals the median is a tie too.
    assert.equal(verdictWord({ value: 12, median: 12, rank: 6, of_years: 24 }), "NORMAL");
    // Tied for 2nd with a big year: still HOT.
    assert.equal(verdictWord({ value: 900, median: 120, rank: 2, of_years: 24 }), "HOT");
    // Tied with the five lowest years: they share 19th, still the bottom quarter.
    assert.equal(verdictWord({ value: 3, median: 40, rank: 19, of_years: 24 }), "NOT");
    // Tied with ten quiet years: they share 14th, which is not the bottom quarter.
    assert.equal(verdictWord({ value: 3, median: 40, rank: 14, of_years: 24 }), "NORMAL");
  });

  it("gives NORMAL when the rank and the median disagree", () => {
    assert.equal(verdictWord({ value: 80, median: 100, rank: 1, of_years: 8 }), "NORMAL", "the highest so far, but below the 2003–2025 median");
    assert.equal(verdictWord({ value: 120, median: 100, rank: 8, of_years: 8 }), "NORMAL");
  });
});

describe("the verdict's words", () => {
  it("says the task's California example", () => {
    assert.deepEqual(verdict(california), {
      word: "HOT",
      period: "November 2026 so far",
      sentence: "397 fire detections, 6th highest of 24 years (usually 282 by now).",
      notes: ["Early numbers, may still change."],
    });
  });

  it("names the highest and lowest year, and drops 'by now' for a whole month", () => {
    const whole = { ...california, days_covered: undefined, provisional: false };
    assert.equal(verdictSentence({ ...whole, rank: 1 }), "397 fire detections, the highest of 24 years (usually 282).");
    assert.equal(verdictSentence({ ...whole, value: 2, rank: 24 }), "2 fire detections, the lowest of 24 years (usually 282).");
    assert.equal(verdictSentence({ ...whole, rank: 21 }), "397 fire detections, 21st highest of 24 years (usually 282).");
    assert.equal(verdictSentence({ ...california, days_covered: 30 }), "397 fire detections, 6th highest of 24 years (usually 282).");
  });

  it("formats small, single and missing values", () => {
    assert.equal(verdictSentence({ ...california, value: 1, median: 0.4 }), "1 fire detection, 6th highest of 24 years (usually 0.4 by now).");
    assert.equal(verdictSentence({ ...california, value: 0.04, median: 0 }), "less than 0.1 fire detections, 6th highest of 24 years (usually 0 by now).");
    assert.equal(verdictSentence({ ...california, value: 1234.4 }), "1,234 fire detections, 6th highest of 24 years (usually 282 by now).");
    assert.equal(verdictSentence({ ...california, rank: null, of_years: null, median: null }), "397 fire detections.");
    assert.equal(verdictSentence({ ...california, rank: 1, of_years: 1 }), "397 fire detections (usually 282 by now).", "no rank among one year");
    assert.equal(verdictSentence({ ...california, value: null }), "No fire data for this month.");
  });

  it("explains a missing word, and flags early numbers and missing passes", () => {
    assert.deepEqual(verdictNotes({ ...california, rank: 2, of_years: 3, provisional: false }), ["Only 3 years to compare, too few for a verdict."]);
    assert.deepEqual(verdictNotes({ ...california, rank: 1, of_years: 1, provisional: false }), ["Only 1 year to compare, too few for a verdict."]);
    assert.deepEqual(verdictNotes({ ...california, rank: null, of_years: null, provisional: false }), ["Months before 2003 are not ranked, so there is no verdict."]);
    assert.deepEqual(verdictNotes({ ...california, median: null, provisional: false }), ["No usual level to compare with, so there is no verdict."]);
    assert.deepEqual(verdictNotes({ ...california, partial_coverage: true }), [
      "Early numbers, may still change.",
      "Some satellite passes are missing, so the count may be low.",
    ]);
    assert.deepEqual(verdictNotes({ ...california, value: null, provisional: false }), []);
  });

  it("gives a sentence but no word for under four years", () => {
    const early = verdict({ year: 2005, month: 1, value: 24233, median: 543, rank: 1, of_years: 3, provisional: false, partial_coverage: false });
    assert.equal(early.word, null);
    assert.equal(early.period, "January 2005");
    assert.equal(early.sentence, "24,233 fire detections, the highest of 3 years (usually 543).");
  });

  it("names the period, with 'so far' only while the month is coming in", () => {
    assert.equal(verdictPeriod({ year: 2026, month: 11, days_covered: 13 }), "November 2026 so far");
    assert.equal(verdictPeriod({ year: 2026, month: 2, days_covered: 28 }), "February 2026");
    assert.equal(verdictPeriod({ year: 2024, month: 2, days_covered: 28 }), "February 2024 so far", "a leap year");
    assert.equal(verdictPeriod({ year: 2019, month: 12 }), "December 2019");
  });

  it("writes counts and ordinals", () => {
    assert.deepEqual([0, 0.04, 0.05, 9.96, 10.4, 12345.6].map(formatCount), ["0", "less than 0.1", "0.1", "10", "10", "12,346"]);
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  });
});

describe("verdictMonth", () => {
  it("is the range's last month when it ends before the newest data, else the newest month", () => {
    assert.equal(verdictMonth(null, "2026-11"), "2026-11");
    assert.equal(verdictMonth("2019-12", "2026-11"), "2019-12");
    assert.equal(verdictMonth("2026-11", "2026-11"), "2026-11");
    assert.equal(verdictMonth("2026-12", "2026-11"), "2026-11");
  });
});

describe("the verdict's figures", async () => {
  const { rankText, ratioText, yearBars } = await import("../public/js/panels/verdict-card.js");

  it("names the rank from the busiest end, with words for the ends", () => {
    assert.equal(rankText(1, 24), "Busiest of 24");
    assert.equal(rankText(4, 24), "4th busiest of 24");
    assert.equal(rankText(22, 24), "22nd busiest of 24");
    assert.equal(rankText(24, 24), "Quietest of 24");
  });

  it("compares with the usual level as a ratio, or not at all without one", () => {
    assert.equal(ratioText(463, 282), "1.6× usual");
    assert.equal(ratioText(0.6, 0.3), "2× usual");
    assert.equal(ratioText(15.36, 15.4), "1× usual");
    assert.equal(ratioText(43732, 533), "82× usual");
    assert.equal(ratioText(10, 40), "0.25× usual");
    assert.equal(ratioText(5, 0), null);
    assert.equal(ratioText(5, null), null);
  });

  it("scales the year bars to the tallest year or the usual level, whichever is higher", () => {
    const { bars, medianHeight, busiest } = yearBars([{ year: 2003, value: 10 }, { year: 2004, value: 0 }, { year: 2005, value: 0.05 }], 20);
    assert.deepEqual(bars.map((bar) => bar.height), [50, 0, 2]);
    assert.equal(medianHeight, 100);
    assert.deepEqual(busiest, { year: 2003, value: 10 });
  });
});

describe("a whole year's verdict", async () => {
  const { yearSummary, yearVerdict } = await import("../public/js/verdict.js");
  // November 2000 to November 2026, each month worth its year minus 2000, except a hot 2010
  // (20 a month) and a cold 2015 (0 a month).
  const months = [];
  for (let year = 2000; year <= 2026; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      if ((year === 2000 && month < 11) || (year === 2026 && month > 11)) continue;
      months.push({ year, month, value: year === 2010 ? 20 : year === 2015 ? 0 : year - 2000 });
    }
  }

  it("totals the year and compares it with the whole baseline years", () => {
    const hot = yearSummary(months, 2010);
    assert.equal(hot.value, 240);
    assert.equal(hot.complete, true);
    assert.equal(hot.rank, 1);
    assert.equal(hot.of_years, 8);
    // Baseline 2003-2025 totals: 12 * (3..25) with 2010 at 240 and 2015 at 0; the 12th of the 23
    // sorted totals is 2014's 168.
    assert.equal(hot.median, 168);
    assert.equal(yearVerdict(hot).word, "HOT");
    assert.equal(yearVerdict(hot).period, "2010");
    const cold = yearSummary(months, 2015);
    assert.deepEqual([cold.value, cold.rank, cold.of_years], [0, 13, 13]);
    assert.equal(yearVerdict(cold).word, "NOT");
  });

  it("does not rank or judge a year that is still running, or one before the baseline", () => {
    const now = yearSummary(months, 2026);
    assert.deepEqual([now.complete, now.rank, now.of_years], [false, null, null]);
    assert.equal(now.value, 11 * 26);
    assert.deepEqual(yearVerdict(now), {
      word: null,
      period: "2026 so far",
      sentence: "286 fire detections in 2026.",
      notes: ["2026 is not over yet, so it is not compared with whole years."],
    });
    assert.deepEqual(yearVerdict(yearSummary(months, 2002)).notes, ["Years before 2003 are not ranked."]);
    assert.deepEqual(yearVerdict(yearSummary(months, 2004)).notes, ["Only 2 years to compare, too few for a verdict."]);
  });

  it("charts every year from the baseline start, the running one included", () => {
    const { history } = yearSummary(months, 2010);
    assert.deepEqual([history[0], history.at(-1), history.length], [{ year: 2003, value: 36 }, { year: 2026, value: 286 }, 24]);
  });
});
