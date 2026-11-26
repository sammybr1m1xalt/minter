"use strict";
/* RED harness: receipt verification must confirm only tokens actually received. */
const { AbiCoder, id, Interface } = require("ethers");
const V = require("/home/anon/minter/dist/fulfillment-verify.js");

const BUYER = "0x1111111111111111111111111111111111112222";
const SELLER = "0x3333333333333333333333333333333333334444";
const COLLECTION = "0x5555555555555555555555555555555555556666";
const OTHER = "0x7777777777777777777777777777777777778888";
const coder = new AbiCoder();
const ERC721 = new Interface(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);
const ERC1155 = new Interface(["event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"]);

function erc721(contract, to, tokenId) {
  const { topics } = ERC721.encodeEventLog(ERC721.getEvent("Transfer"), [SELLER, to, tokenId]);
  return { address: contract, topics: [id("Transfer(address,address,uint256)"), ...topics.slice(1)], data: "0x" };
}
function erc1155(contract, to, tokenId, value = 1) {
  const frag = ERC1155.getEvent("TransferSingle");
  const encoded = ERC1155.encodeEventLog(frag, [SELLER, SELLER, to, tokenId, value]);
  return { address: contract, topics: [id("TransferSingle(address,address,address,uint256,uint256)"), ...encoded.topics.slice(1)], data: encoded.data };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

const expected = { buyer: BUYER, tokenIds: ["1", "2"], collection: COLLECTION };
const good = V.verifyReceiptLogs({ status: 1, logs: [erc721(COLLECTION, BUYER, 1), erc721(COLLECTION, BUYER, 2)] }, expected);
ok("two expected ERC721 transfers confirm", good.status === "confirmed", JSON.stringify(good));

const missing = V.verifyReceiptLogs({ status: 1, logs: [erc721(COLLECTION, BUYER, 1)] }, expected);
ok("one missing token is not success", missing.status === "failed" && missing.missingTokenIds.includes("2"), JSON.stringify(missing));

const wrongTo = V.verifyReceiptLogs({ status: 1, logs: [erc721(COLLECTION, SELLER, 1), erc721(COLLECTION, BUYER, 2)] }, expected);
ok("transfer to someone else does not count", wrongTo.status === "failed", JSON.stringify(wrongTo));

const wrongContract = V.verifyReceiptLogs({ status: 1, logs: [erc721(OTHER, BUYER, 1), erc721(COLLECTION, BUYER, 2)] }, expected);
ok("transfer from another collection is ignored", wrongContract.status === "failed", JSON.stringify(wrongContract));

const reverted = V.verifyReceiptLogs({ status: 0, logs: [] }, expected);
ok("status 0 is reverted", reverted.status === "reverted", JSON.stringify(reverted));

const multi = V.verifyReceiptLogs(
  { status: 1, logs: [erc1155(COLLECTION, BUYER, 1), erc1155(COLLECTION, BUYER, 2)] },
  expected
);
ok("ERC1155 TransferSingle counts", multi.status === "confirmed", JSON.stringify(multi));

console.log(`\n--- ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
