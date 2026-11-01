/**
 * The claim scanner's test.
 *
 * Two things are being proven here, and the second is the one that matters.
 *
 * The first is that the scanner finds what it should: a statistic in prose
 * with no row behind it, and a promise no row could ever back.
 *
 * The second is that it does NOT fire on correct copy. A guard that rejects
 * good drafts is worse than no guard, because the team turns it off. So half
 * of these assertions are about numbers that must be accepted - Indonesian
 * thousands separators, English ones, small counts, years, and the `4.8 kg`
 * that would read as 4,800 to a careless parser.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-claims.ts
 */

import {
  allowedValues,
  formatFindings,
  hasBlocking,
  scanBareStatistics,
  scanClaims,
} from "../src/agent/claims.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

/** The values a plan cited, so these are allowed to appear in the copy. */
const CITED = new Set([610, 4820, 12900]);

const codes = (text: string) => scanClaims(text, "hook").map((f) => f.code);
const stats = (text: string) => scanBareStatistics(text, "hook", CITED);

console.log("test-claims\n");

// ---------------------------------------------------------------- statistics accepted
console.log("# 1. a statistic that traces to a cited row is accepted, in either notation");
{
  check("Indonesian thousands: 4.820", stats("4.820 orang menyimpan ini").length === 0);
  check("English thousands: 4,820", stats("4,820 people saved this").length === 0);
  check("a plain integer", stats("12900 orang melihat").length === 0);
  check("the exact value with a unit", stats("610 simpanan").length === 0);
}

// ---------------------------------------------------------------- statistics rejected
console.log("\n# 2. a statistic with no row behind it is blocked");
{
  const f = stats("12k orang melihat ini");
  check("a k-suffixed number is caught", f.length === 1, JSON.stringify(f.map((x) => x.excerpt)));
  check("it is blocking", f[0]?.severity === "block");
  check("it names the code", f[0]?.code === "STAT-UNCITED");
  check("the message quotes the token", String(f[0]?.message).includes("12k"));

  check("a percentage is always a statistic", stats("97% pengguna cocok").length === 1);
  check("a price is a statistic", stats("Rp 150.000 untuk 3 bulan").length === 1);
  check("an inflated figure is caught", stats("4.900 orang menyimpan").length === 1);
}

// ---------------------------------------------------------------- numbers that are not statistics
console.log("\n# 3. numbers that are not statistics are left alone");
{
  check("small counts", stats("pakai 3 langkah dalam 2 malam").length === 0);
  check("a year", stats("mulai 2026-11-02").length === 0);
  check(
    "a decimal with a non-multiplier unit",
    stats("4.8 kg produk").length === 0,
    JSON.stringify(stats("4.8 kg produk").map((f) => f.excerpt)),
  );
  check("no numbers at all", stats("rutinitas dua langkah sebelum tidur").length === 0);
}

// ---------------------------------------------------------------- claims
console.log("\n# 4. the claims no row could ever support are blocked");
{
  check("a guarantee", codes("dijamin glowing dalam 7 hari").includes("CLAIM-GUARANTEE"));
  check("a guarantee in English", codes("guaranteed results").includes("CLAIM-GUARANTEE"));
  check("a cure claim", codes("menyembuhkan jerawat").includes("CLAIM-CURE"));
  check("a proof claim", codes("terbukti klinis").includes("CLAIM-PROVEN"));
  check("an absolute", codes("aman 100%").includes("CLAIM-ABSOLUTE"));
  check("'selamanya'", codes("aman selamanya").includes("CLAIM-ABSOLUTE"));

  const blocked = scanClaims("dijamin 100% terbukti", "hook");
  check("three rules can fire on one line", blocked.length >= 3, String(blocked.length));
  check("all of them are blocking", blocked.every((f) => f.severity === "block"));
}

// ---------------------------------------------------------------- warnings
console.log("\n# 5. a superlative warns, and a warning must never block");
{
  const f = scanClaims("produk terbaik nomor satu", "hook");
  check("the superlative is caught", f.some((x) => x.code === "CLAIM-SUPERLATIVE"));
  check("it is a warning", f.every((x) => x.severity === "warn"));
  check("hasBlocking says no", hasBlocking(f) === false);

  const g = scanClaims("dijamin viral", "hook");
  check("a guarantee still blocks", hasBlocking(g) === true);
  check("the outcome promise warns", g.some((x) => x.code === "CLAIM-OUTCOME"));

  check("clean copy produces nothing", scanClaims("rutinitas malam yang sederhana", "hook").length === 0);
}

// ---------------------------------------------------------------- shape of a finding
console.log("\n# 6. a finding carries enough to act on");
{
  const f = stats("12k orang melihat")[0]!;
  check("it knows where it is", f.where === "hook");
  check("the excerpt is not empty", f.excerpt.length > 0);
  check("the excerpt is trimmed", f.excerpt === f.excerpt.trim());
  check("the excerpt contains the token", f.excerpt.includes("12k"), f.excerpt);
  check("the message says what to do", f.message.includes("cite the row"));
}

// ---------------------------------------------------------------- helpers
console.log("\n# 7. the helpers");
{
  const allowed = allowedValues([{ value: 610 }, { value: 4820 }], [12900]);
  check("cited values are allowed", allowed.has(610) && allowed.has(4820));
  check("extra allowed values are merged", allowed.has(12900));
  check("an unrelated value is not allowed", !allowed.has(1));

  const text = formatFindings([
    { code: "STAT-UNCITED", severity: "block", where: "hook", excerpt: "x", message: "fix it" },
    { code: "CLAIM-SUPERLATIVE", severity: "warn", where: "cta", excerpt: "y", message: "note it" },
  ]);
  check("a block is marked with ✗", text.includes("✗ [STAT-UNCITED] hook"));
  check("a warning is marked with !", text.includes("! [CLAIM-SUPERLATIVE] cta"));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-claims — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
