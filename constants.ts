
import { Genre, Tone, StoryMode } from './types';

export const GENRES: Genre[] = [
  'Ngôn tình', 'Đam mỹ', 'Bách hợp', 'Tu tiên', 'Xuyên không', 'Trọng sinh', 'Quỷ dị', 
  'Kinh dị tâm lý', 'Huyền huyễn', 'Tiên hiệp', 'Võ hiệp', 'Kiếm hiệp', 'Đô thị hiện đại', 
  'Trinh thám', 'Tội phạm', 'Dark fantasy', 'Hậu tận thế', 'Sci-fi', 
  'Cyberpunk', 'Steampunk', 'Cung đấu', 'Gia đấu', 'Linh dị dân gian', 'Cổ đại', 
  'Cận đại', 'Học đường', 'Hài hước đen', 'Lãng mạn trưởng thành', 
  'Thần thoại cải biên', 'Dị năng', 'Hệ thống', 'Game hóa', 'Sinh tồn', 
  'Tâm lý – triết học', 'Mạt thế', 'Vô hạn lưu', 'Linh dị đô thị', 
  'Hài hước', 'Ngọt sủng', 'Ngược luyến', 'Thám hiểm', 'Kỳ ảo', 
  'Trinh thám pháp y', 'Khoa học huyền bí', 'Thanh xuân vườn trường', 
  'Điền văn', 'Quan trường', 'Quân sự', 'Lịch sử', 'Võng du', 
  'Dã sử', 'Ma đạo', 'Thần thoại', 'Linh khí khôi phục', 'Khoa huyễn',
  'Tây huyễn', 'Ma pháp', 'Luyện đan', 'Làm ruộng', 'Xây dựng thế lực',
  'Cổ xuyên kim', 'Vô địch lưu', 'Phế vật lưu', 'Bình đạm là thật',
  'Showbiz', 'Trinh thám cổ điển', 'Mô phỏng', 'Đa vũ trụ',
  'Thần thoại Bắc Âu', 'Thần thoại Hy Lạp', 'Trùng sinh', 'Thú nhân',
  'Hệ thống tu luyện', 'Reviewer', 'Livestream', 'Xây dựng thành trì'
];

export const TONES: Tone[] = [
  'Nhẹ nhàng', 'Lãng mạn', 'U ám', 'Bi tráng', 'Chữa lành', 
  'Kịch tính', 'Đen tối', 'Triết lý', 'Hài hước', 'Hiện thực gai góc'
];

export const LENGTHS = [800, 1200, 2000, 3000, 5000, 10000, 20000, 50000];

export const MODES: StoryMode[] = [
  'Truyện hoàn chỉnh', 'Mở để viết tiếp', 'Twist ending', 
  'Bi kịch không cứu vãn', 'Happy ending nhưng có giá phải trả'
];
