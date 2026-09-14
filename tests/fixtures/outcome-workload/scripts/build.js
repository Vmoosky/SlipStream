// A deliberately chatty "build" so there is non-test noise to compress too.
const files = ["cart","pricing","inventory","shipping","tax","coupon","catalog","search","session","audit","ledger","invoice"];
console.log('shop-build 1.4.2');
for (const file of files) {
  for (const step of ['parse', 'typecheck', 'transform', 'emit']) {
    console.log(`[${step}] src/${file}.js`);
  }
}
console.log('warning: src/audit.js: unused export "auditNormalize"');
console.log(`built ${files.length} module(s) in 812ms`);
