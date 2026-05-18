# Bút Nghiên AI

Ứng dụng hỗ trợ viết truyện bằng Gemini API. Luồng chính bắt buộc đi theo hồ sơ đầu vào: loại truyện, số chương, số chữ mỗi chương, nhân vật, tính cách, mục tiêu, thể loại, giọng văn, bố cục, Đại cục, Arc và Thiên Cơ Lục.

## Điểm Chính

- Truyện dài chỉ lập Đại cục, Thiên Cơ Lục và lộ trình Arc ở bước đầu để chạy được cả dự án vài trăm đến 1000 chương.
- Khi bắt đầu viết một Arc, app mới sinh bản đồ chương chi tiết cho Arc đó, tránh ép Gemini trả về quá nhiều JSON cùng lúc.
- Mỗi chương có mục tiêu, beat cảnh, chi tiết bắt buộc, nhịp độ, hook và số chữ mục tiêu.
- Khi chấp bút, AI bị ràng buộc bởi Đại cục, Thiên Cơ Lục, Arc hiện tại, bản đồ chương và lịch sử chương trước.
- Sau mỗi chương, app thẩm định logic rồi cập nhật Thiên Cơ Lục để giữ canon, số liệu, timeline và quan hệ nhân vật.
- Dữ liệu được lưu cục bộ bằng IndexedDB và đồng bộ lên Cloud Firestore theo tài khoản Firebase.
- Trên Vercel, Gemini chạy qua API serverless `/api/gemini`, nên Gemini key nằm trong Environment Variables thay vì nằm trong bundle trình duyệt.

## Chạy Local

1. Cài Node.js.
2. Cài dependency:
   `npm install`
3. Tạo `.env.local` theo `.env.example`.
4. Điền `GEMINI_API_KEY_1` đến `GEMINI_API_KEY_6` và cấu hình Firebase nếu cần lưu cloud.
5. Chạy app:
   `npm run dev`

Nếu PowerShell chặn `npm`, dùng:

```powershell
npm.cmd run dev
```

## Cấu Hình Gemini

Mặc định app dùng `gemini-2.5-flash`, phù hợp hơn cho viết truyện vì cân bằng giữa tốc độ, chất lượng và context dài.

- Cụm 1 viết/lập khung: `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`.
- Cụm 2 thẩm định logic/canon: `GEMINI_API_KEY_3`, `GEMINI_API_KEY_4`.
- Cụm 3 sửa lại theo báo cáo thẩm định: `GEMINI_API_KEY_5`, `GEMINI_API_KEY_6`.
- Khi một key lỗi quota/rate-limit, app chỉ đổi sang key còn lại trong cùng cụm nhiệm vụ, không lấy key của cụm khác.
- Chỉ dùng đúng 6 biến đánh số: `GEMINI_API_KEY_1` đến `GEMINI_API_KEY_6`; không dùng biến key gộp hoặc biến đặt theo vai trò để tránh app gọi nhầm cụm.
- `GEMINI_MODEL`: model mặc định.
- `GEMINI_PLAN_MODEL`: model lập lộ trình và kiểm tra logic.
- `GEMINI_WRITE_MODEL`: model viết chương.
- `GEMINI_MAX_OUTPUT_TOKENS`: trần token đầu ra mỗi request, mặc định `8192`.

App tự đổi các tên model cũ như `gemini-1.5-flash` sang model còn hỗ trợ để tránh lỗi 404.

## Firebase

App dùng Firebase Authentication bằng Email/Password và Cloud Firestore qua REST API.

Trong Firebase Console:

1. Vào **Authentication > Sign-in method**.
2. Bật **Email/Password**.
3. Tắt **Anonymous** nếu không muốn người lạ tạo phiên ẩn danh.
4. Vào tab **Users**, tạo tài khoản email/mật khẩu cho người được phép dùng app.
5. Tạo **Cloud Firestore** database.
6. Thêm Web App trong Firebase để lấy config.
7. Đưa các biến này vào `.env.local` và Vercel Environment Variables:

```env
FIREBASE_API_KEY=...
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project
FIREBASE_APP_ID=...
FIREBASE_DATABASE_ID=(default)
```

Security Rules khuyến nghị:

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

File `firestore.rules` trong repo đã có sẵn rule này.

## Deploy Vercel Qua GitHub

1. Push source code lên GitHub.
2. Vào Vercel, chọn **Add New Project** và import repo.
3. Giữ framework là Vite, build command `npm run build`, output directory `dist`.
4. Trong **Settings > Environment Variables**, thêm Gemini và Firebase variables.
5. Sau khi đổi Environment Variables, vào **Deployments** và redeploy bản mới nhất.

App không còn chức năng đồng bộ trực tiếp lên GitHub trong giao diện. GitHub chỉ dùng để lưu source và kích hoạt deploy Vercel; dữ liệu truyện được lưu trên Firebase.

## Ghi Chú Vận Hành

- Với truyện dài, hãy lập lộ trình Arc trước, sau đó vào từng Arc để sinh bản đồ chương và viết chương.
- Không nên đặt số chữ mỗi chương quá lớn nếu key free tier yếu. App có cơ chế viết nối tiếp, nhưng 1500-3000 chữ/chương thường ổn định hơn.
- Nếu Gemini báo 429/503, app sẽ thử key/model dự phòng. Nếu vẫn lỗi, chờ vài phút hoặc giảm số chữ/chương.
- Firebase Web API key có thể nằm trong frontend, nhưng phải dùng Security Rules và nên giới hạn key theo domain trong Google Cloud Console.
