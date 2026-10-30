# browser-check

ตรวจ CORS (BR-56) ด้วยเบราว์เซอร์จริง (Chromium ผ่าน Playwright) โดยใช้ bundle ของ SDK: Node ไม่มี CORS จึงจับเรื่องนี้ไม่ได้

```bash
cd tools/browser-check && npm ci
```

Chromium ต้องมีอยู่แล้ว (ใน sandbox นี้ติดตั้งไว้ที่ `/opt/pw-browsers`; เครื่องอื่นรัน `npx playwright install chromium` เอง) และต้อง build SDK ก่อน (`cd sdk-js && npm run build`)

1. เปิด service ด้วย `CORS_ORIGINS=http://localhost:9001` (ตามกฎใน `CLAUDE.md`: `( cd dir && exec คำสั่ง ) &`, ตรวจ `/healthz`) แล้วรัน `SVC_URL=http://localhost:8080 EXPECT=allowed npm run check` → ต้องได้ `ok`
2. เปิด service โดยไม่ตั้ง `CORS_ORIGINS` แล้วรัน `EXPECT=blocked npm run check` → ต้องได้ `ok` (เบราว์เซอร์บล็อกทั้ง 2 request)

env: `SVC_URL` (default `http://localhost:8080`), `PAGE_PORT` (9001), `ADMIN_KEY`, `CLIENT_KEY`. สคริปต์สร้างและลบ flag ของตัวเองบน service ที่ชี้ไป
