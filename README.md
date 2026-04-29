# Bút Nghiên AI

Ứng dụng hỗ trợ viết truyện bằng Gemini API, tập trung vào cấu trúc đầu vào: số chương, số chữ mỗi chương, nhân vật, tính cách, mục tiêu, thể loại, tông giọng và lộ trình Arc.

## Điểm chính

- Lập bản đồ chương cho toàn bộ truyện dài ngay từ đầu.
- Mỗi chương có mục tiêu, beat nội dung, yếu tố bắt buộc, nhịp độ và số chữ mục tiêu.
- Khi chấp bút, AI được ép bám Đại cục, Thiên Cơ Lục, Arc hiện tại và kế hoạch chương.
- Có thẩm định logic sau khi viết chương và cập nhật Thiên Cơ Lục sau mỗi chương.
- Có kiểm tra logic toàn truyện đã viết: mâu thuẫn, lệch Arc, lặp tình tiết, trọng tâm chương kế tiếp.
- Dùng `gemini-2.5-flash` mặc định: phù hợp viết truyện, context dài và có free tier giới hạn qua Google AI Studio.
- Có thể cấu hình nhiều Gemini API key để xoay khi một key bị rate limit.
- Hỗ trợ truyện ngắn, nhập/xuất dự án JSON và lưu dự án vào IndexedDB của trình duyệt.

## Chạy local

1. Cài Node.js.
2. Cài dependency:
   `npm install`
3. Tạo `.env.local` theo `.env.example` và đặt khóa Gemini:
   `GEMINI_API_KEY=...`
4. Chạy app:
   `npm run dev`

## Cấu hình model

Mặc định app dùng `gemini-2.5-flash`. Đây là lựa chọn cân bằng cho app viết truyện vì nhanh, context dài, chất lượng tốt hơn dòng Lite và có free tier giới hạn.

- `GEMINI_MODEL`: dùng chung cho mọi tác vụ.
- `GEMINI_PLAN_MODEL`: model lập lộ trình/kiểm tra logic.
- `GEMINI_WRITE_MODEL`: model viết chương.
- `GEMINI_FALLBACK_MODELS`: danh sách model dự phòng, cách nhau bằng dấu phẩy, để tự thử khi model chính quá tải 429/503.
- `GEMINI_MAX_OUTPUT_TOKENS`: trần token đầu ra mỗi request. Mặc định 8192.

Nếu muốn tiết kiệm quota hơn, có thể đổi sang `gemini-2.5-flash-lite`, nhưng chất văn và khả năng giữ logic truyện thường yếu hơn `gemini-2.5-flash`.

## Deploy Vercel qua GitHub

1. Đẩy source code này lên một GitHub repository.
2. Vào Vercel, chọn **Add New Project**, import repository đó và giữ build command `npm run build`, output directory `dist`.
3. Trong **Vercel Project Settings > Environment Variables**, thêm các biến Gemini và Firebase đang dùng.
4. Nếu muốn nút **Đồng bộ GitHub** hoạt động, tạo thêm một repo GitHub để lưu dữ liệu truyện, rồi thêm:
   - `GITHUB_SYNC_TOKEN`: fine-grained GitHub token có quyền **Contents: Read and write** với repo lưu trữ.
   - `GITHUB_SYNC_REPO`: dạng `owner/repository`, ví dụ `tenban/but-nghien-archive`.
   - `GITHUB_SYNC_BRANCH`: mặc định `main`.
   - `GITHUB_SYNC_PATH`: thư mục lưu trong repo, mặc định `but-nghien-sync`.

Nên dùng một repo lưu trữ riêng cho dữ liệu truyện. Nếu đồng bộ vào chính repo source đang nối với Vercel, mỗi lần lưu truyện có thể kích hoạt redeploy mới.

Mỗi lần bấm đồng bộ, Vercel API `/api/github-sync` sẽ tạo một commit gồm `index.json`, từng file dự án `.json`, và bản thảo `.txt` nếu tác phẩm đã có chương viết.

## Lưu dữ liệu trên Firebase

App dùng Firebase Auth ẩn danh và Cloud Firestore qua REST API, không cần thêm thư viện Firebase vào bundle.

Trong Firebase Console:

1. Tạo Firebase project.
2. Bật **Authentication > Sign-in method > Anonymous**.
3. Tạo **Cloud Firestore** database.
4. Thêm web app để lấy Firebase config.
5. Thêm các biến này vào `.env.local` khi chạy máy cá nhân và vào Vercel Environment Variables khi deploy:

```env
FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project
FIREBASE_APP_ID=...
FIREBASE_DATABASE_ID=(default)
```

Security Rules gợi ý:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

File [firestore.rules](./firestore.rules) trong repo đã có sẵn rule này để dễ copy vào Firebase Console.

Firebase Web API key có thể nằm trong frontend, nhưng phải bật Security Rules đúng như trên và nên giới hạn key theo domain trong Google Cloud Console. Dữ liệu được lưu theo đường dẫn `users/{uid}/projects/{projectId}`, mỗi tác phẩm được chia chunk để tránh giới hạn 1 MiB của một Firestore document.

## Bảo mật

Khi deploy trên Vercel, Gemini sẽ chạy qua API serverless `/api/gemini`, nên `GEMINI_API_KEY` nằm trong Vercel Environment Variables và không bị nhúng vào bundle trình duyệt. `GITHUB_SYNC_TOKEN` cũng chỉ dùng ở `/api/github-sync`, không đưa xuống frontend.

Khi chạy local bằng `npm run dev`, app vẫn có thể dùng Gemini key từ `.env.local` để tiện thử nghiệm trên máy cá nhân. Nếu muốn local cũng đi qua proxy giống Vercel, chạy bằng `vercel dev` và đặt `GEMINI_SERVER_PROXY=true`.

## Ghi chú

Nếu chọn số chữ rất lớn cho mỗi chương, AI có thể cần nhiều lượt nối tiếp để tiến gần mục tiêu. Ứng dụng đã có cơ chế tự yêu cầu viết tiếp khi bản nháp quá ngắn.
