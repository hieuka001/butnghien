
export type Genre = 
  | 'Ngôn tình' | 'Đam mỹ' | 'Bách hợp' | 'Tu tiên' | 'Xuyên không' | 'Trọng sinh' | 'Quỷ dị' 
  | 'Kinh dị tâm lý' | 'Huyền huyễn' | 'Tiên hiệp' | 'Võ hiệp' | 'Kiếm hiệp' | 'Đô thị hiện đại' 
  | 'Trinh thám' | 'Tội phạm' | 'Dark fantasy' | 'Hậu tận thế' | 'Sci-fi' 
  | 'Cyberpunk' | 'Steampunk' | 'Cung đấu' | 'Gia đấu' | 'Linh dị dân gian' | 'Cổ đại' 
  | 'Cận đại' | 'Học đường' | 'Hài hước đen' | 'Lãng mạn trưởng thành' 
  | 'Thần thoại cải biên' | 'Dị năng' | 'Hệ thống' | 'Game hóa' | 'Sinh tồn' 
  | 'Tâm lý – triết học' | 'Mạt thế' | 'Vô hạn lưu' | 'Linh dị đô thị' 
  | 'Hài hước' | 'Ngọt sủng' | 'Ngược luyến' | 'Thám hiểm' | 'Kỳ ảo' 
  | 'Trinh thám pháp y' | 'Khoa học huyền bí' | 'Thanh xuân vườn trường' 
  | 'Điền văn' | 'Quan trường' | 'Quân sự' | 'Lịch sử' | 'Võng du' 
  | 'Dã sử' | 'Ma đạo' | 'Thần thoại' | 'Linh khí khôi phục' | 'Khoa huyễn'
  | 'Tây huyễn' | 'Ma pháp' | 'Luyện đan' | 'Làm ruộng' | 'Xây dựng thế lực'
  | 'Cổ xuyên kim' | 'Vô địch lưu' | 'Phế vật lưu' | 'Bình đạm là thật'
  | 'Showbiz' | 'Trinh thám cổ điển' | 'Mô phỏng' | 'Đa vũ trụ'
  | 'Thần thoại Bắc Âu' | 'Thần thoại Hy Lạp' | 'Trùng sinh' | 'Thú nhân'
  | 'Hệ thống tu luyện' | 'Reviewer' | 'Livestream' | 'Xây dựng thành trì';

export type Tone = 
  | 'Nhẹ nhàng' | 'Lãng mạn' | 'U ám' | 'Bi tráng' | 'Chữa lành' 
  | 'Kịch tính' | 'Đen tối' | 'Triết lý' | 'Hài hước' | 'Hiện thực gai góc';

export type StoryMode = 
  | 'Truyện hoàn chỉnh' | 'Mở để viết tiếp' | 'Twist ending' 
  | 'Bi kịch không cứu vãn' | 'Happy ending nhưng có giá phải trả';

export type ProjectType = 'Truyện Ngắn' | 'Trường Thiên';

export interface CharacterConfig {
  name: string;
  gender: 'Nam' | 'Nữ' | 'Không xác định' | 'Tự do';
  personality?: string;
  goal?: string;
}

export interface AdvancedSliders {
  romance: number;
  violence: number;
  philosophy: number;
  psychology: number;
  action: number;
  strategy: number;
}

export interface Chapter {
  index: number;
  title: string;
  summary: string;
  content?: string;
  bibleSnapshot?: string;
  objective?: string;
  beats?: string[];
  mustInclude?: string[];
  cliffhanger?: string;
  targetWords?: number;
  pacing?: 'Chậm' | 'Trung bình' | 'Nhanh' | 'Cao trào';
}

export interface Volume {
  index: number;
  title: string;
  summary: string;
  purpose?: string;
  chapterStart?: number;
  chapterEnd?: number;
  chapters: Chapter[];
}

export interface StoryParams {
  projectType: ProjectType;
  totalChapters: number;
  length: number;
  genres: Genre[];
  tone: Tone;
  character: CharacterConfig;
  sliders: AdvancedSliders;
  mode: StoryMode;
  seed?: string;
  referenceStories?: string;
  directionLock?: string;
}

export interface StoryProject {
  id: string;
  title: string;
  params: StoryParams;
  generalSummary: string;
  progressionSummary: string; 
  volumes: Volume[];
  createdAt: number;
  updatedAt: number;
  lastChapterWritten: number;
}

export interface StoryLogicIssue {
  severity: 'Cao' | 'Vừa' | 'Nhẹ';
  chapter?: number;
  issue: string;
  fix: string;
}

export interface StoryLogicReport {
  score: number;
  summary: string;
  issues: StoryLogicIssue[];
  suggestions: string[];
  nextChapterFocus: string;
}
