// ERC-8495 trait reading: value is required, trait_type is optional,
// display_type decides how a value is read.
const R = require("/home/anon/minter/dist/rarity.js");

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`);
  }
};

// ── parseTraits ──────────────────────────────────────────────────────────────
const doc = {
  name: "T1",
  attributes: [
    { trait_type: "Color", value: "Red" },
    { trait_type: "Level", value: 5, display_type: "number", max_value: 10 },
    { trait_type: "Stamina", value: 10, display_type: "boost_percentage" },
    { trait_type: "Birthday", value: 1546360800, display_type: "date" },
    { value: "Nameless" }, // valid per the schema: value REQUIRED, trait_type SHOULD
    { trait_type: "Mystery", value: 7, display_type: "wat" }, // unknown -> absent
    { trait_type: "NoValue" }, // malformed: value is REQUIRED
    { trait_type: "Empty", value: "" },
    null,
  ],
};

const p = R.parseTraits(doc);
ok("categorical trait read", p.traits[0].kind === "categorical" && p.traits[0].value === "Red", p.traits[0].value);
ok("number display_type -> numeric", p.traits[1].kind === "numeric", p.traits[1].kind);
ok("max_value carried", p.traits[1].maxValue === 10, String(p.traits[1].maxValue));
ok("boost_percentage -> numeric", p.traits[2].kind === "numeric", p.traits[2].kind);
ok("date -> date", p.traits[3].kind === "date", p.traits[3].kind);
ok("numeric value coerced to string", p.traits[1].value === "5", p.traits[1].value);
ok("missing trait_type is KEPT, not dropped", p.traits.some((t) => t.type === "(unnamed)" && t.value === "Nameless"));
ok("missing trait_type is counted", p.missingType === 1, `${p.missingType}`);
ok("unknown display_type -> categorical", p.traits.find((t) => t.type === "Mystery")?.kind === "categorical");
ok("unknown display_type is counted", p.unknownDisplayType === 1, `${p.unknownDisplayType}`);
ok("entry with no value is dropped", !p.traits.some((t) => t.type === "NoValue"));
ok("entry with empty value is dropped", !p.traits.some((t) => t.type === "Empty"));
ok("missing values counted (2 real + 1 null)", p.missingValue === 3, `${p.missingValue}`);

// ── computeRarity: date traits must not dominate ─────────────────────────────
const tokens = [];
for (let i = 1; i <= 4; i++) {
  tokens.push({
    tokenId: i,
    traits: [
      { type: "Color", value: i === 1 ? "Red" : "Blue", kind: "categorical", displayType: null },
      // A unique timestamp per token: the bug this fixes.
      { type: "Birthday", value: String(1546360800 + i), kind: "date", displayType: "date" },
    ],
  });
}
const rep = R.computeRarity(tokens);
ok("date traits excluded from the count", rep.excludedDateTraits === 4, `${rep.excludedDateTraits}`);
ok("all 4 tokens carry a date trait", rep.tokensWithDateTraits === 4, `${rep.tokensWithDateTraits}`);
ok("date traits are absent from frequencies", rep.frequencies.Birthday === undefined);
ok("the single Red token ranks first", rep.rows[0].traits.find((t) => t.type === "Color").value === "Red", rep.rows[0].traits.find((t) => t.type === "Color").value);
const reds = rep.rows.filter((r) => r.traits.find((t) => t.type === "Color").value === "Red");
const blues = rep.rows.filter((r) => r.traits.find((t) => t.type === "Color").value === "Blue");
ok("Red scores higher than Blue", reds[0].score > blues[0].score, `${reds[0].score} > ${blues[0].score}`);
ok(
  "score reflects only the scorable trait",
  Math.abs(reds[0].score - 4 / 1) < 1e-9,
  reds[0].score
);
ok("rarest is not a date trait", rep.rows[0].rarest?.type === "Color", rep.rows[0].rarest?.type);

// ── old cache entries re-read as categorical ─────────────────────────────────
const os = require("os");
const fs = require("fs");
const path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rarity-cache-"));
const cid = "QmTest";
// Reach the cache file path the way the module does: write through saveRarityCache
// is not possible for a legacy shape, so write the legacy JSON directly.
const cachePath = path.resolve(__dirname, "..", "..", ".minter-cache", "rarity", `${cid}.json`);
fs.mkdirSync(path.dirname(cachePath), { recursive: true });
fs.writeFileSync(
  cachePath,
  JSON.stringify({ cid, updatedAt: "old", tokens: [{ tokenId: 1, traits: [{ type: "Color", value: "Red" }] }] })
);
const loaded = R.loadRarityCache(cid);
ok("legacy cache entry loads", loaded.length === 1);
ok("legacy entry defaults to categorical", loaded[0].traits[0].kind === "categorical", loaded[0].traits[0].kind);
fs.rmSync(cachePath, { force: true });
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
