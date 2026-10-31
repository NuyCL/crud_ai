// FNV-1a 32-bit ตาม spec/evaluation.md ข้อ 4 : node docs/lab/assets/fnv1a.mjs "<input>" ...
// (เขียนเองในไฟล์เดียว เพื่อใช้ตรวจ tests/vectors ด้วยมือ ไม่ได้เป็นส่วนของ service)
function fnv1a32(s) {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0; // คูณแบบ 32 บิตแล้วแปลงกลับเป็น unsigned
  }
  return h >>> 0;
}
for (const s of process.argv.slice(2)) {
  const h = fnv1a32(s);
  console.log(`${JSON.stringify(s)}\thash=${h}\tbucket=${h % 10000}`);
}
