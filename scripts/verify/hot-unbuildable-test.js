// A struct/invite mint must be named, not reported as a bare "no buildable mint".
const H = require("/home/anon/minter/dist/hot-cli.js");

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

const tupleMint = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    outputs: [],
    inputs: [
      {
        name: "auth",
        type: "tuple",
        internalType: "struct Auth",
        components: [
          { name: "key", type: "bytes32" },
          { name: "proof", type: "bytes32[]" },
        ],
      },
      { name: "quantity", type: "uint256" },
      { name: "affiliate", type: "address" },
      { name: "signature", type: "bytes" },
    ],
  },
];
const scalarMint = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    outputs: [],
    inputs: [{ name: "quantity", type: "uint256" }],
  },
];

const named = H.describeUnbuildable(tupleMint);
ok("names the real struct signature", named.includes("mint((bytes32,bytes32[]),uint256,address,bytes)"), named);
ok("names the wallet-specific proof blocker", /wallet-specific proof/.test(named));
ok("shows the tuple argument", /auth: tuple/.test(named));
const plain = H.describeUnbuildable(scalarMint);
ok("scalar ABIs get the generic reason", /No scalar mint signature matched/.test(plain), plain);

console.log(`\n--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
