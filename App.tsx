
import { 
  generateInitialRoadmap, 
  generateNextArc, 
  generateChapterPlansForArc,
  generateChapterStream, 
  updateWorldBibleAndSummary, 
  generateShortStoryStream,
  validateChapterLogic,
  reviewStoryLogic,
  getConfiguredGeminiKeyCount
} from './services/geminiService';
import {
  deleteProjectFromDb,
  loadProjectsFromDb,
  replaceAllProjectsInDb,
  saveProjectToDb,
} from './services/databaseService';
import {
  deleteProjectFromFirebase,
  type FirebaseAuthUser,
  getFirebaseProjectId,
  getStoredFirebaseUser,
  isFirebaseConfigured,
  loadProjectsFromFirebase,
  saveProjectToFirebase,
  saveProjectsToFirebase,
  signInToFirebase,
  signOutFromFirebase,
} from './services/firebaseService';
import React, { useState, useEffect, useRef } from 'react';
import { GENRES, TONES, MODES } from './constants';
import { StoryParams, StoryProject, Genre, Chapter, Volume, StoryLogicReport } from './types';

const MIN_TOTAL_CHAPTERS = 1;
const MAX_TOTAL_CHAPTERS = 1000;
const MIN_CHAPTER_WORDS = 300;
const MAX_CHAPTER_WORDS = 20000;

const DEFAULT_PARAMS: StoryParams = {
  projectType: 'Trường Thiên',
  totalChapters: 50,
  length: 2000,
  genres: ['Tiên hiệp'],
  tone: 'Bi tráng',
  character: { name: 'Lâm Phong', gender: 'Nam', personality: 'Kiên định, lạnh lùng', goal: 'Báo thù' },
  sliders: { romance: 0, violence: 0, philosophy: 0, psychology: 0, action: 0, strategy: 0 },
  mode: 'Truyện hoàn chỉnh',
  seed: '',
  referenceStories: ''
};

const sortChaptersByIndex = (chapters: Chapter[] = []) => [...chapters].sort((a, b) => a.index - b.index);
const highestWrittenChapterIndex = (volumes: Volume[] = []) => Math.max(
  0,
  ...volumes
    .flatMap(volume => volume.chapters || [])
    .filter(chapter => chapter.content)
    .map(chapter => chapter.index),
);

const normalizeProjectRecord = (project: StoryProject): StoryProject => ({
  ...project,
  title: project.title || 'Tác phẩm chưa đặt tên',
  params: {
    ...DEFAULT_PARAMS,
    ...(project.params || {}),
    character: { ...DEFAULT_PARAMS.character, ...(project.params?.character || {}) },
    sliders: { ...DEFAULT_PARAMS.sliders, ...(project.params?.sliders || {}) },
    genres: project.params?.genres?.length ? project.params.genres : DEFAULT_PARAMS.genres,
  },
  generalSummary: project.generalSummary || project.params?.seed || '',
  progressionSummary: project.progressionSummary || '',
  volumes: (project.volumes || []).map(volume => ({
    ...volume,
    chapters: sortChaptersByIndex(volume.chapters || [])
  })),
  createdAt: project.createdAt || Date.now(),
  updatedAt: project.updatedAt || Date.now(),
  lastChapterWritten: Math.max(project.lastChapterWritten || 0, highestWrittenChapterIndex(project.volumes || [])),
});

const App: React.FC = () => {
  const [projects, setProjects] = useState<StoryProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [params, setParams] = useState<StoryParams>(DEFAULT_PARAMS);

  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [writtenChapters, setWrittenChapters] = useState<Chapter[]>([]); 
  const [generalSummary, setGeneralSummary] = useState<string>('');
  const [worldBible, setWorldBible] = useState<string>('');
  const [currentChapterIndex, setCurrentChapterIndex] = useState<number>(1);
  const [activeArcIndex, setActiveArcIndex] = useState<number>(1); 
  const [chapterIdea, setChapterIdea] = useState<string>('');
  const [story, setStory] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [generationStatus, setGenerationStatus] = useState<string>('');
  const [isGeneratingOutline, setIsGeneratingOutline] = useState<boolean>(false);
  const [isHydrated, setIsHydrated] = useState<boolean>(false);
  const [storageStatus, setStorageStatus] = useState<string>('Đang mở database...');
  const [cloudStatus, setCloudStatus] = useState<string>(isFirebaseConfigured() ? 'Đang mở Firebase...' : 'Firebase chưa cấu hình');
  const [authUser, setAuthUser] = useState<FirebaseAuthUser | null>(() => getStoredFirebaseUser());
  const [loginEmail, setLoginEmail] = useState<string>('');
  const [loginPassword, setLoginPassword] = useState<string>('');
  const [authError, setAuthError] = useState<string>('');
  const [isSigningIn, setIsSigningIn] = useState<boolean>(false);
  const [isCheckingLogic, setIsCheckingLogic] = useState<boolean>(false);
  const [logicReport, setLogicReport] = useState<StoryLogicReport | null>(null);
  const [view, setView] = useState<'editor' | 'outline' | 'manuscript' | 'setup' | 'my-stories' | 'bible'>('setup');

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      if (isFirebaseConfigured() && !authUser) {
        setProjects([]);
        setStorageStatus('Chưa mở dữ liệu');
        setCloudStatus('Cần đăng nhập Firebase');
        setIsHydrated(true);
        return;
      }

      setIsHydrated(false);
      try {
        if (isFirebaseConfigured()) {
          try {
            const firebaseProjects = (await loadProjectsFromFirebase()).map(normalizeProjectRecord);
            if (cancelled) return;

            setProjects(firebaseProjects);
            await replaceAllProjectsInDb(firebaseProjects);
            setStorageStatus(`IndexedDB đã lưu cache ${firebaseProjects.length} tác phẩm`);
            setCloudStatus(firebaseProjects.length > 0
              ? `Firebase đã tải ${firebaseProjects.length} tác phẩm từ ${getFirebaseProjectId()}`
              : `Firebase sẵn sàng cho ${authUser?.email || 'tài khoản này'}`
            );
            return;
          } catch (firebaseError) {
            console.warn(firebaseError);
            if (!cancelled) {
              setProjects([]);
              setCloudStatus('Không tải được Firebase. Hãy kiểm tra đăng nhập/quyền truy cập.');
              return;
            }
          }
        }

        const dbProjects = (await loadProjectsFromDb()).map(normalizeProjectRecord);
        if (cancelled) return;

        if (dbProjects.length > 0) {
          setProjects(dbProjects);
          setStorageStatus(`IndexedDB đã tải ${dbProjects.length} tác phẩm`);
        } else {
          const saved = localStorage.getItem('but-nghien-v19-store');
          const legacyProjects = saved ? (JSON.parse(saved) as StoryProject[]).map(normalizeProjectRecord) : [];
          setProjects(legacyProjects);
          if (legacyProjects.length > 0) {
            await replaceAllProjectsInDb(legacyProjects);
            setStorageStatus(`Đã chuyển ${legacyProjects.length} tác phẩm từ localStorage sang IndexedDB`);
          } else {
            setStorageStatus('IndexedDB sẵn sàng');
          }
        }
      } catch (e) {
        console.error(e);
        const saved = localStorage.getItem('but-nghien-v19-store');
        if (saved) {
          try {
            setProjects((JSON.parse(saved) as StoryProject[]).map(normalizeProjectRecord));
            setStorageStatus('Đang dùng localStorage dự phòng');
          } catch {
            setStorageStatus('Không đọc được dữ liệu lưu trữ');
          }
        } else {
          setStorageStatus('Không mở được database');
        }
      } finally {
        if (!cancelled) setIsHydrated(true);
      }
    };

    hydrate();
    return () => { cancelled = true; };
  }, [authUser?.uid]);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      localStorage.setItem('but-nghien-v19-store', JSON.stringify(projects));
    } catch (error) {
      console.warn('LocalStorage đầy hoặc không ghi được, IndexedDB vẫn là nguồn lưu chính:', error);
    }
    replaceAllProjectsInDb(projects)
      .then(() => setStorageStatus(`IndexedDB đã lưu ${projects.length} tác phẩm`))
      .catch(error => {
        console.error(error);
        setStorageStatus('Lưu IndexedDB lỗi, đã giữ bản localStorage');
      });

    if (!isFirebaseConfigured()) {
      setCloudStatus('Firebase chưa cấu hình');
      return;
    }
    if (!authUser) {
      setCloudStatus('Cần đăng nhập Firebase để lưu dữ liệu');
      return;
    }

    setCloudStatus(projects.length > 0 ? 'Đang lưu Firebase...' : 'Firebase sẵn sàng');
    const timer = window.setTimeout(() => {
      saveProjectsToFirebase(projects)
        .then(() => setCloudStatus(`Firebase đã lưu ${projects.length} tác phẩm`))
        .catch(error => {
          console.error(error);
          setCloudStatus('Lưu Firebase lỗi, dữ liệu vẫn còn trong máy');
        });
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [projects, isHydrated, authUser?.uid]);

  const toggleGenre = (genre: Genre) => {
    setParams(prev => ({
      ...prev,
      genres: prev.genres.includes(genre) ? prev.genres.filter(g => g !== genre) : [...prev.genres, genre]
    }));
  };

  const handleProjectTypeChange = (projectType: StoryParams['projectType']) => {
    setParams(prev => ({
      ...prev,
      projectType,
      totalChapters: projectType === 'Truyện Ngắn' ? 1 : Math.max(2, prev.totalChapters || 5),
    }));
  };

  const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const normalizeParams = (draft: StoryParams): StoryParams => {
    const requestedTotalChapters = clampNumber(Math.round(Number(draft.totalChapters) || 1), MIN_TOTAL_CHAPTERS, MAX_TOTAL_CHAPTERS);
    const effectiveProjectType = draft.projectType === 'Truyện Ngắn' && requestedTotalChapters > 1 ? 'Trường Thiên' : draft.projectType;

    return {
      ...draft,
      projectType: effectiveProjectType,
      totalChapters: effectiveProjectType === 'Truyện Ngắn' ? 1 : requestedTotalChapters,
      length: clampNumber(Math.round(Number(draft.length) || 2000), MIN_CHAPTER_WORDS, MAX_CHAPTER_WORDS),
      genres: draft.genres.length > 0 ? draft.genres : ['Kỳ ảo'],
      seed: draft.seed?.trim() || '',
      referenceStories: draft.referenceStories?.trim() || '',
      character: {
        ...draft.character,
        name: (draft.character.name || '').trim(),
        personality: draft.character.personality?.trim(),
        goal: draft.character.goal?.trim()
      }
    };
  };

  const validateSetupParams = (draft: StoryParams) => {
    if (getConfiguredGeminiKeyCount() === 0) return 'Chưa có GEMINI_API_KEY trong .env.local. Hãy điền key rồi khởi động lại server.';
    if (!draft.seed?.trim()) return 'Hãy nhập ý tưởng khởi nguồn.';
    if (!draft.character.name?.trim()) return 'Hãy nhập tên nhân vật chính.';
    if (!draft.character.personality?.trim()) return 'Hãy nhập tính cách nhân vật chính để AI giữ logic nhân vật.';
    if (draft.genres.length === 0) return 'Hãy chọn ít nhất một thể loại.';
    if (draft.totalChapters < MIN_TOTAL_CHAPTERS || draft.totalChapters > MAX_TOTAL_CHAPTERS) return `Số chương nên nằm trong khoảng ${MIN_TOTAL_CHAPTERS}-${MAX_TOTAL_CHAPTERS}.`;
    if (draft.length < MIN_CHAPTER_WORDS || draft.length > MAX_CHAPTER_WORDS) return `Số chữ/chương nên nằm trong khoảng ${MIN_CHAPTER_WORDS}-${MAX_CHAPTER_WORDS}. Nếu muốn dài hơn, hãy tách thành nhiều chương để giữ chất lượng và quota.`;
    return '';
  };

  const friendlyError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('GEMINI_API_KEY')) return message;
    if (message.includes('429')) return 'Gemini đang bị giới hạn quota/rate limit. Hãy chờ một lúc, giảm số chữ/chương, hoặc dùng key khác.';
    if (message.includes('503') || message.toLowerCase().includes('high demand')) return 'Gemini đang quá tải. Hệ thống đã thử model dự phòng nhưng vẫn chưa có lượt trống; hãy chờ vài phút rồi thử lại.';
    if (message.includes('400')) return 'Gemini từ chối request. Kiểm tra lại tên model, GEMINI_MAX_OUTPUT_TOKENS hoặc giảm độ dài chương.';
    if (message.includes('403') || message.includes('401')) return 'Gemini API key không hợp lệ hoặc chưa được cấp quyền dùng API.';
    if (message.includes('JSON')) return 'AI trả về dữ liệu chưa đúng định dạng. Hãy thử lại; app hiện chỉ yêu cầu Arc ở bước đầu và sẽ sinh bản đồ chương theo từng Arc khi viết.';
    if (message.includes('Failed to fetch')) return 'Không kết nối được Gemini API. Kiểm tra mạng hoặc CORS/trình duyệt.';
    return message || 'Có lỗi không xác định.';
  };

  const friendlyAuthError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('EMAIL_NOT_FOUND') || message.includes('INVALID_LOGIN_CREDENTIALS')) return 'Email hoặc mật khẩu không đúng.';
    if (message.includes('INVALID_PASSWORD')) return 'Mật khẩu không đúng.';
    if (message.includes('USER_DISABLED')) return 'Tài khoản này đã bị tắt trong Firebase.';
    if (message.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) return 'Bạn thử sai quá nhiều lần. Hãy chờ một lúc rồi đăng nhập lại.';
    if (message.includes('INVALID_EMAIL')) return 'Email không hợp lệ.';
    if (message.includes('Firebase Auth')) return 'Không đăng nhập được Firebase. Kiểm tra cấu hình Authentication.';
    return message || 'Không đăng nhập được.';
  };

  const resetWorkspace = () => {
    setProjects([]);
    setActiveProjectId(null);
    setVolumes([]);
    setWrittenChapters([]);
    setGeneralSummary('');
    setWorldBible('');
    setStory('');
    setChapterIdea('');
    setLogicReport(null);
    setCurrentChapterIndex(1);
    setActiveArcIndex(1);
    setView('setup');
  };

  const handleSignIn = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSigningIn) return;
    if (!loginEmail.trim() || !loginPassword) {
      setAuthError('Hãy nhập email và mật khẩu.');
      return;
    }

    setIsSigningIn(true);
    setAuthError('');
    try {
      const user = await signInToFirebase(loginEmail.trim(), loginPassword);
      setAuthUser(user);
      setLoginPassword('');
      setCloudStatus(`Đã đăng nhập ${user.email}`);
    } catch (error) {
      setAuthError(friendlyAuthError(error));
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = () => {
    signOutFromFirebase();
    localStorage.removeItem('but-nghien-v19-store');
    replaceAllProjectsInDb([]).catch(error => console.error('Không xóa được cache IndexedDB:', error));
    resetWorkspace();
    setAuthUser(null);
    setIsHydrated(false);
    setStorageStatus('Đã khóa dữ liệu trên thiết bị này');
    setCloudStatus('Cần đăng nhập Firebase');
  };

  const sortChapters = sortChaptersByIndex;
  const projectTitleFromSeed = (seed?: string) => {
    const title = (seed || 'Tác phẩm mới').trim().replace(/\s+/g, ' ');
    return title.length > 34 ? `${title.slice(0, 34)}...` : title;
  };

  const extractGeneratedTitle = (content: string, fallback: string) => {
    const titleMatch = content.match(/^\s*(?:Tên chương|Tên truyện)\s*:\s*(.+)$/im);
    if (!titleMatch) return { title: fallback, body: content.trim() };
    const body = content.replace(titleMatch[0], '').trim();
    return { title: titleMatch[1].trim() || fallback, body };
  };

  const buildOpeningWorldBible = (
    rawWorldBuilding: string,
    summary: string,
    draft: StoryParams,
    draftVolumes: Volume[],
  ) => {
    const arcLines = draftVolumes
      .map(volume => `- Arc ${volume.index} (${volume.chapterStart}-${volume.chapterEnd}): ${volume.title} - ${volume.summary}`)
      .join('\n');
    const chapterLines = draftVolumes
      .flatMap(volume => sortChapters(volume.chapters || []).map(chapter => `- C.${chapter.index}: ${chapter.title} | ${chapter.objective || chapter.summary}`))
      .join('\n');
    const chapterPlanNotice = draftVolumes.some(volume => (volume.chapters || []).length > 0)
      ? chapterLines
      : '- Bản đồ chương chi tiết sẽ được sinh theo từng Arc khi bắt đầu viết Arc đó.';

    return [
      '# DIỄN TIẾN TRUYỆN',
      summary || draft.seed || 'Đại cục đã được lập theo hồ sơ đầu vào.',
      '',
      '# TIMELINE',
      '- Chương 1 là mốc mở màn. Mọi mốc thời gian phát sinh sau này phải được ghi lại theo thứ tự.',
      '- Dữ kiện chưa có ngày/giờ cụ thể được đánh dấu "chưa khóa" thay vì tự đặt số tùy tiện.',
      '',
      '# SỐ LIỆU VÀ QUY TẮC',
      `- Lộ trình khóa: ${draft.totalChapters} chương, mục tiêu ${draft.length} chữ/chương.`,
      '- Tuổi, số lượng, tiền bạc, khoảng cách, cấp bậc, thời hạn, tài nguyên và luật thế giới phải giữ nhất quán khi đã xuất hiện.',
      '- Dữ kiện định lượng chưa chắc chắn phải ghi "chưa khóa".',
      '',
      '# NHÂN VẬT CHÍNH',
      `- ${draft.character.name}: ${draft.character.personality || 'chưa mô tả tính cách'}.`,
      `- Mục tiêu: ${draft.character.goal || 'chưa mô tả mục tiêu'}.`,
      '',
      '# NHÂN VẬT PHỤ VÀ QUAN HỆ',
      '- Chưa khóa. Mỗi nhân vật phụ mới phải có quan hệ, chức năng trong Arc và trạng thái sau khi xuất hiện.',
      '',
      '# ĐỊA DANH/VẬT PHẨM/HỆ THỐNG',
      rawWorldBuilding?.trim() || 'Thế giới sẽ được giữ nhất quán theo thể loại, luật nhân quả và các giới hạn đã đặt.',
      '',
      '# LỘ TRÌNH ARC',
      arcLines || 'Arc chưa có dữ liệu.',
      '',
      '# BẢN ĐỒ CHƯƠNG',
      chapterPlanNotice || 'Chưa có bản đồ chương.',
      '',
      '# MÂU THUẪN ĐANG MỞ',
      '- Mâu thuẫn khởi nguồn phải được đẩy qua từng chương, không giải quyết quá sớm.',
      '',
      '# ĐIỀU CẤM PHÁ LOGIC',
      '- Không đổi tên riêng, số liệu, timeline, cảnh giới, vật phẩm, quan hệ hoặc luật thế giới nếu chưa có nguyên nhân và hậu quả trong truyện.',
      '- Không mở tuyến phụ không phục vụ mục tiêu chương hoặc Arc hiện tại.',
      '- Không dùng hồi tưởng/miêu tả/giải thích dài nếu đoạn đó không làm thay đổi mục tiêu, lựa chọn hoặc hậu quả.',
      '',
      '# ĐỐI CHIẾU LOGIC',
      '- Mỗi chương chỉ được viết sau khi có mục tiêu chương, Arc hiện tại và Thiên Cơ Lục khởi tạo.',
      '- Sau mỗi chương, hệ thống phải cập nhật dữ kiện mới, mâu thuẫn còn mở và nguy cơ lệch canon.',
    ].join('\n');
  };

  const getVolumeRange = (volume: Volume) => {
    const chapterIndexes = (volume.chapters || []).map(chapter => chapter.index).filter(Number.isFinite);
    const start = Number.isFinite(volume.chapterStart)
      ? Number(volume.chapterStart)
      : (chapterIndexes.length ? Math.min(...chapterIndexes) : undefined);
    const end = Number.isFinite(volume.chapterEnd)
      ? Number(volume.chapterEnd)
      : (chapterIndexes.length ? Math.max(...chapterIndexes) : undefined);
    return Number.isFinite(start) && Number.isFinite(end)
      ? { start: start as number, end: end as number }
      : null;
  };

  const hasCompleteArcChapterPlan = (volume: Volume) => {
    const range = getVolumeRange(volume);
    if (!range) return false;
    const chapterIndexes = new Set((volume.chapters || []).map(chapter => chapter.index));
    for (let index = range.start; index <= range.end; index++) {
      if (!chapterIndexes.has(index)) return false;
    }
    return true;
  };

  const getActiveArc = () => volumes.find(v => v.index === activeArcIndex);
  const getChapterPlan = (chapterIndex: number, arcIndex = activeArcIndex) =>
    volumes.find(v => v.index === arcIndex)?.chapters?.find(ch => ch.index === chapterIndex);
  const getArcByChapterIndex = (chapterIndex: number) => volumes.find(volume => {
    const range = getVolumeRange(volume);
    return Boolean(range && chapterIndex >= range.start && chapterIndex <= range.end);
  });
  const activeProject = projects.find(project => project.id === activeProjectId);
  const plannedChapters = sortChapters(volumes.flatMap(volume => volume.chapters || []));
  const generatedChapterPlanCount = plannedChapters.length;
  const plannedChapterIndexes = new Set<number>();
  volumes.forEach(volume => {
    const range = getVolumeRange(volume);
    if (!range) return;
    for (let index = Math.max(1, range.start); index <= Math.min(params.totalChapters, range.end); index++) {
      plannedChapterIndexes.add(index);
    }
  });
  const writtenChapterIndexes = new Set(writtenChapters.map(chapter => chapter.index));
  const missingChapterIndexes = params.projectType === 'Trường Thiên'
    ? Array.from({ length: Math.max(0, params.totalChapters) }, (_, index) => index + 1).filter(index => !plannedChapterIndexes.has(index))
    : [];
  const roadmapIssues = params.projectType === 'Trường Thiên'
    ? [
        volumes.length === 0 ? 'Chưa có Arc.' : '',
        missingChapterIndexes.length > 0 ? `Thiếu chương ${missingChapterIndexes.slice(0, 6).join(', ')}${missingChapterIndexes.length > 6 ? '...' : ''}.` : '',
        !generalSummary.trim() ? 'Chưa có Đại cục.' : '',
        !worldBible.trim() ? 'Chưa có Thiên Cơ Lục.' : '',
      ].filter(Boolean)
    : [];
  const hasRoadmapReady = params.projectType !== 'Trường Thiên' || roadmapIssues.length === 0;
  const firstUnwrittenChapterIndex = params.projectType === 'Trường Thiên'
    ? Array.from({ length: Math.max(0, params.totalChapters) }, (_, index) => index + 1).find(index => plannedChapterIndexes.has(index) && !writtenChapterIndexes.has(index))
    : undefined;
  const firstUnwrittenPlan = firstUnwrittenChapterIndex
    ? plannedChapters.find(chapter => chapter.index === firstUnwrittenChapterIndex)
    : plannedChapters.find(chapter => !writtenChapterIndexes.has(chapter.index));
  const currentChapterPlan = getChapterPlan(currentChapterIndex);
  const planCompletenessPercent = params.projectType === 'Trường Thiên'
    ? Math.min(100, Math.round((plannedChapterIndexes.size / Math.max(1, params.totalChapters)) * 100))
    : 100;
  const canonChecklist = [
    { label: 'Timeline', ok: /#\s*TIMELINE/i.test(worldBible) },
    { label: 'Số liệu', ok: /#\s*SỐ LIỆU/i.test(worldBible) },
    { label: 'Quan hệ', ok: /NHÂN VẬT PHỤ|NHÂN VẬT VÀ QUAN HỆ/i.test(worldBible) },
    { label: 'Hệ thống', ok: /ĐỊA DANH|VẬT PHẨM|HỆ THỐNG/i.test(worldBible) },
    { label: 'Mâu thuẫn', ok: /MÂU THUẪN ĐANG MỞ/i.test(worldBible) },
    { label: 'Cấm phá logic', ok: /ĐIỀU CẤM PHÁ LOGIC|ĐỐI CHIẾU LOGIC/i.test(worldBible) },
  ];
  const canonReadyCount = canonChecklist.filter(item => item.ok).length;
  const progressPercent = params.projectType === 'Trường Thiên'
    ? Math.round((writtenChapters.length / Math.max(1, params.totalChapters)) * 100)
    : (plannedChapters.length > 0 ? Math.round((writtenChapters.length / plannedChapters.length) * 100) : 0);
  const workflowSteps = [
    { label: 'Hồ sơ', status: params.seed.trim() && params.character.name.trim() ? 'done' : 'active' },
    { label: 'Lộ trình', status: hasRoadmapReady ? 'done' : activeProjectId ? 'active' : 'locked' },
    { label: 'Chấp bút', status: writtenChapters.length > 0 ? 'done' : hasRoadmapReady ? 'active' : 'locked' },
    { label: 'Biên tập', status: logicReport ? 'done' : writtenChapters.length > 0 ? 'active' : 'locked' },
  ];
  const isStoryProject = (value: unknown): value is StoryProject => {
    const project = value as Partial<StoryProject>;
    return Boolean(project?.id && project?.params && Array.isArray(project?.volumes));
  };

  const downloadTextFile = (filename: string, content: string, mime = 'text/plain;charset=utf-8') => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const buildManuscriptText = (project: StoryProject) => {
    const chapters = sortChapters((project.volumes || []).flatMap(volume => volume.chapters || []).filter(chapter => chapter.content));
    const header = [
      project.title,
      '',
      `Thể loại: ${project.params.genres.join(', ')}`,
      `Tông giọng: ${project.params.tone}`,
      `Số chương đã viết: ${chapters.length}`,
      '',
      'ĐẠI CỤC',
      project.generalSummary,
      '',
      'BẢN THẢO',
      ''
    ].join('\n');

    const body = chapters
      .map(chapter => `Chương ${chapter.index}: ${chapter.title}\n\n${chapter.content || ''}`)
      .join('\n\n---\n\n');

    return `${header}${body}`.trim();
  };

  const handleExportManuscript = (project: StoryProject, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const safeTitle = project.title.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_') || 'ButNghien';
    downloadTextFile(`BanThao_${safeTitle}.txt`, buildManuscriptText(project));
  };

  const mergeArcPlans = (currentArc: Volume, plannedArc: Volume): Volume => {
    const existingByIndex = new Map((currentArc.chapters || []).map(chapter => [chapter.index, chapter]));
    const plannedIndexes = new Set((plannedArc.chapters || []).map(chapter => chapter.index));
    const mergedPlans = (plannedArc.chapters || []).map(plan => {
      const existing = existingByIndex.get(plan.index);
      return existing?.content
        ? { ...plan, title: existing.title || plan.title, summary: existing.summary || plan.summary, content: existing.content, bibleSnapshot: existing.bibleSnapshot }
        : { ...existing, ...plan };
    });
    const extraExisting = (currentArc.chapters || []).filter(chapter => !plannedIndexes.has(chapter.index));

    return {
      ...currentArc,
      ...plannedArc,
      chapters: sortChapters([...mergedPlans, ...extraExisting]),
    };
  };

  const ensureArcChapterPlans = async (arcIndex: number): Promise<Volume> => {
    const currentArc = volumes.find(volume => volume.index === arcIndex);
    if (!currentArc) throw new Error('Không tìm thấy Arc trong lộ trình.');
    if (hasCompleteArcChapterPlan(currentArc)) return currentArc;

    setGenerationStatus(`Đang lập bản đồ chương cho ${currentArc.title}...`);
    const plannedArc = await generateChapterPlansForArc(params, worldBible, generalSummary, currentArc, writtenChapters);
    const mergedArc = mergeArcPlans(currentArc, plannedArc);
    const updatedVolumes = volumes.map(volume => volume.index === arcIndex ? mergedArc : volume);
    setVolumes(updatedVolumes);
    setProjects(prevProjects => prevProjects.map(project => project.id === activeProjectId
      ? { ...project, volumes: updatedVolumes, updatedAt: Date.now() }
      : project
    ));
    return mergedArc;
  };

  const handleWriteChapter = async () => {
    if (isGenerating) return;
    if (!activeProjectId) {
      alert('Hãy mở hoặc tạo một dự án trước khi viết chương.');
      return;
    }
    if (params.projectType === 'Trường Thiên' && currentChapterIndex > params.totalChapters) {
      alert(`Tác phẩm đã đạt lộ trình ${params.totalChapters} chương. Hãy tăng số chương hoặc tạo Arc mở rộng nếu muốn viết tiếp.`);
      return;
    }
    const chapterArc = getArcByChapterIndex(currentChapterIndex) || getActiveArc();
    if (params.projectType === 'Trường Thiên' && (!hasRoadmapReady || !chapterArc)) {
      alert('Chưa có đủ bố cục Arc và Thiên Cơ Lục. Hãy lập lộ trình trước khi chấp bút.');
      setView('outline');
      return;
    }

    setIsGenerating(true);
    setStory('');

    if (params.projectType === 'Truyện Ngắn') {
      try {
        setGenerationStatus('Đang viết truyện ngắn hoàn chỉnh...');
        const fullText = await generateShortStoryStream(params, (chunk) => setStory(prev => prev + chunk), chapterIdea);
        if (!fullText.trim()) throw new Error('Gemini chưa trả về nội dung truyện. Hãy thử lại với mục tiêu chữ thấp hơn hoặc bấm viết lại.');

        const extracted = extractGeneratedTitle(fullText, writtenChapters[0]?.title || 'Toàn văn');
        const shortChapter: Chapter = {
          ...(writtenChapters[0] || {}),
          index: 1,
          title: extracted.title,
          content: extracted.body,
          summary: params.seed || extracted.body.slice(0, 240),
          targetWords: params.length,
        };
        const shortVolume: Volume = {
          ...(volumes[0] || {}),
          index: 1,
          title: 'Truyện ngắn',
          summary: 'Nội dung truyện ngắn hoàn chỉnh',
          purpose: 'Hoàn chỉnh một truyện độc lập',
          chapterStart: 1,
          chapterEnd: 1,
          chapters: [shortChapter],
        };
        const nextWrittenList = [shortChapter];
        setWrittenChapters(nextWrittenList);
        setVolumes([shortVolume]);
        setWorldBible('Truyện ngắn hoàn chỉnh.');
        setStory(extracted.body);
        setProjects(prevProjects => prevProjects.map(p => p.id === activeProjectId
          ? {
              ...p,
              title: extracted.title || p.title,
              volumes: [shortVolume],
              progressionSummary: 'Truyện ngắn hoàn chỉnh.',
              lastChapterWritten: 1,
              updatedAt: Date.now(),
            }
          : p
        ));
      } catch (e) {
        console.error(e);
        alert(friendlyError(e));
      } finally {
        setIsGenerating(false);
        setGenerationStatus('');
      }
      return;
    }
    
    let attempts = 0;
    const maxAttempts = 2;
    let isValid = false;
    let finalContent = "";

    try {
      let workingVolumes = volumes;
      let currentArc = chapterArc || { index: activeArcIndex, title: 'Tự do', summary: 'Không có lộ trình cụ thể.', chapters: [] };
      if (params.projectType === 'Trường Thiên' && !hasCompleteArcChapterPlan(currentArc as Volume)) {
        currentArc = await ensureArcChapterPlans(currentArc.index);
        workingVolumes = volumes.map(volume => volume.index === currentArc.index ? currentArc : volume);
      }
      setActiveArcIndex(currentArc.index);
      const chapterPlan = currentArc.chapters?.find(ch => ch.index === currentChapterIndex);
      const previousForValidation = writtenChapters.filter(ch => ch.index !== currentChapterIndex);

      while (attempts < maxAttempts && !isValid) {
        attempts++;
        setGenerationStatus(attempts > 1 ? `Đang viết lại cho sát lộ trình và đủ số chữ...` : `Đang chấp bút Chương ${currentChapterIndex} theo bản đồ chương...`);
        
        finalContent = await generateChapterStream(
          params, writtenChapters, currentChapterIndex, worldBible, chapterIdea, generalSummary, 
          currentArc,
          (chunk) => setStory(prev => prev + chunk),
          attempts > 1
        );
        setStory(finalContent);
        if (!finalContent.trim()) throw new Error('Gemini chưa trả về nội dung chương. Hãy thử lại hoặc giảm mục tiêu số chữ.');

        setGenerationStatus('Đang thẩm định số chữ, canon, logic và độ tập trung...');
        const validation = await validateChapterLogic(finalContent, previousForValidation, worldBible, currentArc, generalSummary, params, currentChapterIndex);
        
        if (validation.isValid) {
          isValid = true;
        } else {
          console.warn("Lệch lộ trình:", validation.reason);
          if (attempts < maxAttempts) {
            setGenerationStatus(`Chưa đạt khóa canon. ${validation.reason || 'Đang viết lại chặt hơn...'}`);
            setStory(''); 
          }
        }
      }

      if (!isValid) {
        console.warn("Chương cần biên tập thêm, nhưng vẫn lưu bản tốt nhất đã viết.");
      }

      setGenerationStatus('Đang cập nhật Thiên Cơ Lục và khóa dữ kiện mới...');
      let updates: { chapterTitle?: string; chapterSummary?: string; updatedBible: string };
      try {
        updates = await updateWorldBibleAndSummary(worldBible, finalContent, currentChapterIndex, generalSummary, params, currentArc);
      } catch (updateError) {
        console.warn('Không cập nhật được Thiên Cơ Lục, vẫn lưu chương đã viết:', updateError);
        updates = {
          chapterTitle: chapterPlan?.title || `Chương ${currentChapterIndex}`,
          chapterSummary: chapterPlan?.summary || finalContent.slice(0, 240),
          updatedBible: worldBible,
        };
      }
      
      const extracted = extractGeneratedTitle(finalContent, updates.chapterTitle || chapterPlan?.title || `Chương ${currentChapterIndex}`);
      const finalTitle = updates.chapterTitle || extracted.title;
      const actualText = extracted.body;

      const newChapter: Chapter = {
        ...chapterPlan,
        index: currentChapterIndex,
        title: finalTitle,
        content: actualText,
        summary: updates.chapterSummary || chapterPlan?.summary || '',
        bibleSnapshot: updates.updatedBible,
        targetWords: chapterPlan?.targetWords || params.length
      };

      const nextWrittenList = writtenChapters.some(c => c.index === newChapter.index)
        ? sortChapters(writtenChapters.map(c => c.index === newChapter.index ? newChapter : c))
        : sortChapters([...writtenChapters, newChapter]);

      setWrittenChapters(nextWrittenList);
      setWorldBible(updates.updatedBible);
      setStory(actualText);

      const updatedVolumes = workingVolumes.map(v => {
        if (v.index === currentArc.index) {
          const existingInVol = v.chapters || [];
          const isChapterInVol = existingInVol.some(c => c.index === newChapter.index);
          return {
            ...v,
            chapters: isChapterInVol
              ? sortChapters(existingInVol.map(c => c.index === newChapter.index ? { ...c, ...newChapter } : c))
              : sortChapters([...existingInVol, newChapter])
          };
        }
        return v;
      });

      setVolumes(updatedVolumes);
      setProjects(prevProjects => prevProjects.map(p => p.id === activeProjectId
        ? { ...p, volumes: updatedVolumes, progressionSummary: updates.updatedBible, lastChapterWritten: Math.max(0, ...nextWrittenList.map(chapter => chapter.index)), updatedAt: Date.now() }
        : p
      ));
    } catch (e) { 
        console.error(e);
        alert(friendlyError(e)); 
    }
    finally { setIsGenerating(false); setGenerationStatus(''); }
  };

  const handleStartProject = async () => {
    const validationError = validateSetupParams(params);
    if (validationError) return alert(validationError);

    const workingParams = normalizeParams(params);
    setParams(workingParams);
    setIsGeneratingOutline(true);
    setGenerationStatus(workingParams.projectType === 'Truyện Ngắn' ? 'Đang viết truyện ngắn hoàn chỉnh...' : 'Bước 1/3: Đang dựng Đại cục và chia Arc...');
    setLogicReport(null);
    try {
      if (workingParams.projectType === 'Truyện Ngắn') {
        setView('editor');
        setStory('');
        const fullText = await generateShortStoryStream(workingParams, (chunk) => setStory(prev => prev + chunk));
        const extracted = extractGeneratedTitle(fullText, 'Toàn văn');
        const newId = Date.now().toString();
        const shortChapter: Chapter = { index: 1, title: extracted.title, content: extracted.body, summary: workingParams.seed || '', targetWords: workingParams.length };
        const shortVolume: Volume = { index: 1, title: 'Truyện ngắn', summary: 'Nội dung truyện ngắn hoàn chỉnh', chapterStart: 1, chapterEnd: 1, chapters: [shortChapter] };
        const newProj: StoryProject = { 
          id: newId, title: extracted.title || projectTitleFromSeed(workingParams.seed), params: workingParams, 
          generalSummary: workingParams.seed || '', progressionSummary: "Truyện ngắn", 
          volumes: [shortVolume], createdAt: Date.now(), updatedAt: Date.now(), lastChapterWritten: 1 
        };
        setProjects(prev => [newProj, ...prev]);
        setActiveProjectId(newId);
        setVolumes([shortVolume]);
        setWrittenChapters([shortChapter]);
        setGeneralSummary(workingParams.seed || '');
        setWorldBible('Truyện ngắn hoàn chỉnh.');
        setCurrentChapterIndex(1);
        setActiveArcIndex(1);
        setStory(extracted.body);
      } else {
        const result = await generateInitialRoadmap(workingParams);
        setGenerationStatus('Bước 2/3: Đang kiểm tra độ phủ chương và khóa sổ canon...');
        if (!result || !result.volumes?.length) throw new Error("Dữ liệu lộ trình không hợp lệ.");
        const initialVolumes = result.volumes;
        const coveredIndexes = new Set<number>();
        initialVolumes.forEach((volume: Volume) => {
          const range = getVolumeRange(volume);
          if (!range) return;
          for (let index = Math.max(1, range.start); index <= Math.min(workingParams.totalChapters, range.end); index++) {
            coveredIndexes.add(index);
          }
        });
        if (coveredIndexes.size < workingParams.totalChapters) {
          throw new Error(`Lộ trình Arc chưa phủ đủ ${workingParams.totalChapters} chương. Hãy thử lại hoặc giảm số chương.`);
        }
        const initialSummary = result.generalSummary || workingParams.seed;
        const initialBible = buildOpeningWorldBible(result.worldBuilding || '', initialSummary, workingParams, initialVolumes);
        setGenerationStatus('Bước 3/3: Đang mở bàn viết và lưu dự án...');
        setVolumes(initialVolumes);
        setWrittenChapters([]);
        setGeneralSummary(initialSummary);
        setWorldBible(initialBible);
        setCurrentChapterIndex(1);
        setActiveArcIndex(1);
        const newId = Date.now().toString();
        const newProj: StoryProject = {
          id: newId,
          title: result.title || projectTitleFromSeed(workingParams.seed),
          params: workingParams,
          generalSummary: initialSummary,
          progressionSummary: initialBible,
          volumes: initialVolumes,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastChapterWritten: 0
        };
        setProjects(prev => [newProj, ...prev]);
        setActiveProjectId(newId);
        setView('outline');
      }
    } catch (e) { console.error(e); alert(friendlyError(e)); }
    finally { setIsGeneratingOutline(false); setGenerationStatus(''); }
  };

  const handleAddNextArc = async () => {
    if (isGeneratingOutline) return;
    if (getConfiguredGeminiKeyCount() === 0) return alert('Chưa có GEMINI_API_KEY trong .env.local. Hãy điền key rồi khởi động lại server.');
    setIsGeneratingOutline(true);
    setGenerationStatus('Đang lập Arc mở rộng dựa trên Đại cục và Thiên Cơ Lục...');
    try {
      const nextVol = await generateNextArc(params, worldBible, volumes, writtenChapters, generalSummary);
      const expandedTotalChapters = Math.max(params.totalChapters, nextVol.chapterEnd || params.totalChapters);
      const nextParams = expandedTotalChapters !== params.totalChapters
        ? { ...params, totalChapters: expandedTotalChapters }
        : params;
      const updatedVolumes = [...volumes, nextVol];
      if (nextParams !== params) setParams(nextParams);
      setVolumes(updatedVolumes);
      setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, params: nextParams, volumes: updatedVolumes, updatedAt: Date.now() } : p));
    } catch (e) { console.error(e); alert(friendlyError(e)); }
    finally { setIsGeneratingOutline(false); setGenerationStatus(''); }
  };

  const handleReviewStoryLogic = async () => {
    if (isCheckingLogic || writtenChapters.length === 0) return;
    setIsCheckingLogic(true);
    setGenerationStatus('Đang kiểm tra logic toàn bộ bản thảo...');
    try {
      const report = await reviewStoryLogic(params, volumes, writtenChapters, worldBible, generalSummary);
      setLogicReport(report);
      setView('bible');
    } catch (e) {
      console.error(e);
      alert(friendlyError(e));
    } finally {
      setIsCheckingLogic(false);
      setGenerationStatus('');
    }
  };

  const handlePrepareWriteChapter = async (arcIndex: number) => {
    if (!hasRoadmapReady) {
      alert('Chưa có đủ bố cục Arc và Thiên Cơ Lục. Hãy lập lộ trình trước khi viết.');
      setView('outline');
      return;
    }
    if (isGeneratingOutline) return;
    setIsGeneratingOutline(true);
    setActiveArcIndex(arcIndex);
    try {
      const arc = await ensureArcChapterPlans(arcIndex);
      const firstUnwritten = sortChapters(arc.chapters || []).find(ch => !writtenChapters.some(written => written.index === ch.index));
      if (!firstUnwritten) {
        alert('Arc này đã viết xong. Hãy chọn chương chưa viết ở Arc khác hoặc xem bản thảo.');
        setView('outline');
        return;
      }
      setCurrentChapterIndex(firstUnwritten.index);
      setChapterIdea('');
      setStory('');
      setView('editor');
    } catch (error) {
      console.error(error);
      alert(friendlyError(error));
    } finally {
      setIsGeneratingOutline(false);
      setGenerationStatus('');
    }
  };

  const openEditorWithGuard = async () => {
    if (!hasRoadmapReady) {
      alert('Chưa có đủ bố cục Arc và Thiên Cơ Lục. Hãy lập lộ trình trước khi chấp bút.');
      setView('outline');
      return;
    }
    const nextIndex = firstUnwrittenChapterIndex || firstUnwrittenPlan?.index;
    if (nextIndex) {
      const nextArc = getArcByChapterIndex(nextIndex);
      if (!nextArc) {
        alert('Không tìm thấy Arc cho chương kế tiếp. Hãy lập lại lộ trình.');
        setView('outline');
        return;
      }
      if (!hasCompleteArcChapterPlan(nextArc)) {
        await handlePrepareWriteChapter(nextArc.index);
        return;
      }
      setActiveArcIndex(nextArc.index);
      setCurrentChapterIndex(nextIndex);
      setChapterIdea('');
      setStory('');
    }
    setView('editor');
  };

  const handleWriteNextChapter = async () => {
    const availableIndexes = Array.from({ length: Math.max(0, params.totalChapters) }, (_, index) => index + 1)
      .filter(index => plannedChapterIndexes.has(index) && !writtenChapterIndexes.has(index));
    const nextIndex = availableIndexes.find(index => index > currentChapterIndex) || availableIndexes[0];
    if (!nextIndex) {
      alert('Không còn chương chưa viết trong lộ trình hiện tại.');
      setView('outline');
      return;
    }

    const nextArc = getArcByChapterIndex(nextIndex);
    if (!nextArc) {
      alert('Không tìm thấy Arc cho chương kế tiếp.');
      setView('outline');
      return;
    }
    if (!hasCompleteArcChapterPlan(nextArc)) {
      await handlePrepareWriteChapter(nextArc.index);
      return;
    }
    setActiveArcIndex(nextArc.index);
    setCurrentChapterIndex(nextIndex);
    setChapterIdea('');
    setStory('');
    setView('editor');
  };

  const handleReadChapter = (chapter: Chapter, arcIndex: number) => {
    setStory(chapter.content || ''); setCurrentChapterIndex(chapter.index); setActiveArcIndex(arcIndex); setView('editor');
  };

  const handleRewriteChapter = (chapter: Chapter, arcIndex: number) => {
    setCurrentChapterIndex(chapter.index); setActiveArcIndex(arcIndex); setChapterIdea(''); setStory(''); setView('editor');
  };

  const handleDeleteChapter = (chapterIndex: number, _arcIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`⚠️ Xóa vĩnh viễn nội dung chương ${chapterIndex}?`)) {
      const nextWrittenList = writtenChapters.filter(c => c.index !== chapterIndex);
      const updatedVolumes = volumes.map(v => ({
        ...v,
        chapters: (v.chapters || []).map(c => c.index === chapterIndex
          ? { ...c, content: undefined, bibleSnapshot: undefined }
          : c
        )
      }));
      setWrittenChapters(nextWrittenList);
      setVolumes(updatedVolumes);
      setProjects(prevProjects => prevProjects.map(p => p.id === activeProjectId
        ? { ...p, volumes: updatedVolumes, lastChapterWritten: Math.max(0, ...nextWrittenList.map(chapter => chapter.index)), updatedAt: Date.now() }
        : p
      ));
    }
  };

  const handleDeleteProject = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm("⚠️ Bạn có chắc chắn muốn xóa vĩnh viễn tác phẩm này khỏi Tàng Thư local và Firebase?")) {
      deleteProjectFromDb(id).catch(error => console.error("Không xóa được trong IndexedDB:", error));
      deleteProjectFromFirebase(id).catch(error => console.error("Không xóa được trong Firebase:", error));
      const updatedProjects = projects.filter(p => p.id !== id);
      setProjects(updatedProjects);
      if (activeProjectId === id) {
        setActiveProjectId(null);
        setVolumes([]);
        setWrittenChapters([]);
        setGeneralSummary('');
        setWorldBible('');
        setLogicReport(null);
        setView('setup');
      }
    }
  };

  const loadProject = (p: StoryProject) => {
    const loadedVolumes = (p.volumes || []).map(v => ({ ...v, chapters: sortChapters(v.chapters || []) }));
    setActiveProjectId(p.id); setParams(p.params); setVolumes(loadedVolumes);
    const loadedWritten = sortChapters(loadedVolumes.flatMap(v => v.chapters || []).filter(c => c.content));
    const loadedPlans = sortChapters(loadedVolumes.flatMap(v => v.chapters || []));
    const loadedNextPlan = loadedPlans.find(chapter => !loadedWritten.some(written => written.index === chapter.index));
    const loadedBible = p.params.projectType === 'Truyện Ngắn'
      ? (p.progressionSummary || 'Truyện ngắn hoàn chỉnh.')
      : (p.progressionSummary || buildOpeningWorldBible('', p.generalSummary || p.params.seed || '', p.params, loadedVolumes));
    const loadedNextArc = loadedNextPlan ? loadedVolumes.find(volume => (volume.chapters || []).some(chapter => chapter.index === loadedNextPlan.index)) : undefined;
    setWrittenChapters(loadedWritten); setWorldBible(loadedBible); setGeneralSummary(p.generalSummary || '');
    setActiveArcIndex(loadedNextArc?.index || loadedVolumes[0]?.index || 1);
    setCurrentChapterIndex(loadedNextPlan?.index || loadedWritten[loadedWritten.length - 1]?.index || 1);
    setStory(p.params.projectType === 'Truyện Ngắn' ? (loadedWritten[0]?.content || '') : '');
    setLogicReport(null);
    setView(p.params.projectType === 'Truyện Ngắn' ? 'editor' : 'outline');
  };

  const getWordCount = (text: string) => text ? text.trim().split(/\s+/).filter(Boolean).length : 0;

  const renderBibleContent = (content: string) => {
    if (!content) return <p className="text-slate-400 italic">Thiên cơ đang thành hình...</p>;
    const sections = content.split(/(?=# )/g);
    return (
      <div className="space-y-12">
        {sections.map((section, idx) => {
          const lines = section.split('\n');
          const title = lines[0].replace('#', '').trim();
          const body = lines.slice(1).join('\n').trim();
          if (!title && !body) return null;
          const isLogic = title.toLowerCase().includes('đối chiếu');
          return (
            <div key={idx} className={`relative p-8 rounded-3xl border ${isLogic ? 'bg-indigo-50/50 border-indigo-200' : 'bg-white border-slate-100 shadow-sm'} transition-all hover:shadow-md group`}>
              <div className="flex items-center gap-3 mb-4">
                 <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-white ${isLogic ? 'bg-indigo-600' : 'bg-slate-800'}`}>
                    {idx + 1}
                 </div>
                 <h3 className={`font-black uppercase tracking-widest text-sm story-font ${isLogic ? 'text-indigo-900' : 'text-slate-900'}`}>{title || "Chi tiết"}</h3>
              </div>
              <div className={`story-font text-lg leading-relaxed whitespace-pre-wrap ${isLogic ? 'italic text-indigo-700' : 'text-slate-700'}`}>
                {body}
              </div>
              {isLogic && (
                <div className="absolute -bottom-4 -right-4 w-16 h-16 bg-white border-2 border-indigo-600 rounded-full flex items-center justify-center rotate-12 shadow-lg border-dashed">
                  <span className="text-[8px] font-black uppercase text-indigo-600 text-center leading-none">Thiên Cơ<br/>Xác Thực</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  if (isFirebaseConfigured() && !authUser) {
    return (
      <div className="min-h-screen bg-[#f8f5f2] text-slate-900 flex items-center justify-center p-6 bg-[url('https://www.transparenttextures.com/patterns/paper.png')]">
        <section className="w-full max-w-5xl grid lg:grid-cols-[1fr_0.9fr] gap-6 items-stretch">
          <div className="bg-white border border-slate-100 rounded-[2rem] p-8 md:p-12 shadow-xl flex flex-col justify-center">
            <span className="inline-flex w-fit px-3 py-1 bg-indigo-50 text-indigo-700 rounded-full text-[9px] font-black uppercase tracking-widest mb-6">Không gian riêng</span>
            <h1 className="story-font text-4xl md:text-6xl font-black italic leading-tight mb-4">
              Bút Nghiên <span className="text-indigo-700 not-italic">Thiên Cơ</span>
            </h1>
            <p className="story-font text-lg text-slate-500 leading-relaxed">
              Đăng nhập để mở Tàng Thư, dữ liệu Firebase và bàn viết của bạn.
            </p>
            <div className="grid sm:grid-cols-3 gap-3 mt-8">
              <div className="p-4 bg-slate-50 border border-slate-100 rounded-2xl">
                <span className="block text-[8px] font-black uppercase text-slate-400">Firebase</span>
                <strong className="text-xs font-black text-slate-800">{getFirebaseProjectId()}</strong>
              </div>
              <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-2xl">
                <span className="block text-[8px] font-black uppercase text-emerald-700">Bảo mật</span>
                <strong className="text-xs font-black text-emerald-900">Email / mật khẩu</strong>
              </div>
              <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-2xl">
                <span className="block text-[8px] font-black uppercase text-indigo-600">Dữ liệu</span>
                <strong className="text-xs font-black text-indigo-900">Theo tài khoản</strong>
              </div>
            </div>
          </div>

          <form onSubmit={handleSignIn} className="bg-slate-950 text-white rounded-[2rem] p-6 md:p-8 shadow-2xl flex flex-col justify-center gap-5">
            <div>
              <span className="text-[9px] font-black uppercase text-emerald-300 tracking-widest">Đăng nhập</span>
              <h2 className="text-2xl font-black story-font mt-2">Chỉ tài khoản được cấp mới vào được app</h2>
            </div>
            <label className="space-y-2">
              <span className="block text-[9px] font-black uppercase text-slate-400">Email</span>
              <input
                type="email"
                value={loginEmail}
                onChange={event => setLoginEmail(event.target.value)}
                autoComplete="email"
                className="w-full p-4 rounded-2xl bg-white/10 border border-white/10 text-white outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder="ban@example.com"
              />
            </label>
            <label className="space-y-2">
              <span className="block text-[9px] font-black uppercase text-slate-400">Mật khẩu</span>
              <input
                type="password"
                value={loginPassword}
                onChange={event => setLoginPassword(event.target.value)}
                autoComplete="current-password"
                className="w-full p-4 rounded-2xl bg-white/10 border border-white/10 text-white outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder="Mật khẩu Firebase"
              />
            </label>
            {authError && (
              <p className="p-3 rounded-2xl bg-red-500/15 border border-red-400/20 text-red-100 text-sm font-bold">
                {authError}
              </p>
            )}
            <button
              type="submit"
              disabled={isSigningIn}
              className="w-full py-4 bg-indigo-300 text-indigo-950 rounded-2xl font-black text-[10px] uppercase tracking-widest hover:bg-white transition-all disabled:opacity-50"
            >
              {isSigningIn ? 'Đang kiểm tra...' : 'Mở Bút Nghiên'}
            </button>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Tài khoản được tạo trong Firebase Console. Không có tài khoản thì không thể vào app.
            </p>
          </form>
        </section>
      </div>
    );
  };

  return (
    <div className="app-shell flex flex-col md:flex-row h-screen overflow-hidden text-slate-800 font-sans">
      <aside className="control-panel w-full md:w-[360px] max-h-[48vh] md:max-h-none border-b md:border-b-0 p-4 md:p-5 flex flex-col gap-4 shrink-0 z-20 overflow-y-auto custom-scrollbar">
        <div className="flex items-center gap-3 pb-4 border-b">
          <div className="w-10 h-10 bg-indigo-900 text-white rounded-xl flex items-center justify-center font-black italic">BN</div>
          <h1 onClick={() => setView('setup')} className="text-xl font-black text-indigo-900 cursor-pointer italic hover:text-indigo-600 transition-all">Bút Nghiên AI</h1>
        </div>
        {isFirebaseConfigured() && authUser && (
          <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-100 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block text-[8px] font-black uppercase text-emerald-700">Đã đăng nhập</span>
              <span className="block text-[10px] font-bold text-emerald-950 truncate">{authUser.email}</span>
            </div>
            <button onClick={handleSignOut} className="px-3 py-2 bg-white text-emerald-800 rounded-lg text-[8px] font-black uppercase border border-emerald-100 hover:bg-emerald-700 hover:text-white transition-all shrink-0">
              Đăng xuất
            </button>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
            <span className="block text-[8px] font-black uppercase text-slate-400">Gemini</span>
            <span className="text-xs font-black text-indigo-700">{getConfiguredGeminiKeyCount()} key</span>
          </div>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
            <span className="block text-[8px] font-black uppercase text-slate-400">Database</span>
            <span className="text-[9px] font-bold text-slate-500 line-clamp-2">{storageStatus}</span>
          </div>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
            <span className="block text-[8px] font-black uppercase text-slate-400">Firebase</span>
            <span className="text-[9px] font-bold text-slate-500 line-clamp-2">{cloudStatus}</span>
          </div>
        </div>
        <div className="p-4 bg-slate-950 text-white rounded-lg shadow-sm space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="block text-[8px] font-black uppercase text-emerald-300 tracking-widest">Quy trình</span>
              <span className="block text-xs font-black">Tạo truyện theo khóa logic</span>
            </div>
            <span className="text-[10px] font-black text-slate-300">{planCompletenessPercent}%</span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {workflowSteps.map(step => (
              <div key={step.label} className={`h-1.5 rounded-full ${step.status === 'done' ? 'bg-emerald-400' : step.status === 'active' ? 'bg-amber-300' : 'bg-white/15'}`} title={step.label} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {workflowSteps.map(step => (
              <div key={step.label} className={`px-2 py-1.5 rounded-lg text-[8px] font-black uppercase ${step.status === 'done' ? 'bg-emerald-400/15 text-emerald-200' : step.status === 'active' ? 'bg-amber-300/15 text-amber-100' : 'bg-white/5 text-slate-500'}`}>
                {step.label}
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-5">
          <div className="flex bg-slate-100 p-1 rounded-xl">
            {(['Truyện Ngắn', 'Trường Thiên'] as const).map(t => (
              <button key={t} onClick={() => handleProjectTypeChange(t)} className={`flex-1 py-2 text-[10px] font-bold uppercase rounded-lg transition-all ${params.projectType === t ? 'bg-white shadow text-indigo-600' : 'text-slate-400'}`}>{t}</button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase">Giọng văn</label>
              <select value={params.tone} onChange={e => setParams({...params, tone: e.target.value as StoryParams['tone']})} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold outline-none">
                {TONES.map(tone => <option key={tone} value={tone}>{tone}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase">Kết cấu</label>
              <select value={params.mode} onChange={e => setParams({...params, mode: e.target.value as StoryParams['mode']})} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold outline-none">
                {MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}
              </select>
            </div>
          </div>

          <div className={`grid ${params.projectType === 'Trường Thiên' ? 'grid-cols-2' : 'grid-cols-1'} gap-3`}>
            {params.projectType === 'Trường Thiên' && (
              <div className="space-y-1">
                <label className="text-[9px] font-black text-slate-400 uppercase">Số chương</label>
                <input type="number" min={MIN_TOTAL_CHAPTERS} max={MAX_TOTAL_CHAPTERS} value={params.totalChapters} onChange={e => setParams({...params, totalChapters: parseInt(e.target.value) || 1})} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold focus:ring-1 focus:ring-indigo-300 outline-none" />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase">{params.projectType === 'Trường Thiên' ? 'Số chữ/Chương' : 'Số chữ truyện'}</label>
              <input type="number" min={MIN_CHAPTER_WORDS} max={MAX_CHAPTER_WORDS} step={100} value={params.length} onChange={e => setParams({...params, length: parseInt(e.target.value) || 500})} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold focus:ring-1 focus:ring-indigo-300 outline-none" />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[9px] font-black text-slate-400 uppercase">Nhân vật chính</label>
            <input type="text" value={params.character.name} onChange={e => setParams({...params, character: {...params.character, name: e.target.value}})} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold" placeholder="Tên..." />
            <textarea value={params.character.personality} onChange={e => setParams({...params, character: {...params.character, personality: e.target.value}})} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] h-16" placeholder="Tính cách..." />
            <textarea value={params.character.goal} onChange={e => setParams({...params, character: {...params.character, goal: e.target.value}})} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-[10px] h-14" placeholder="Mục tiêu, nỗi sợ, vết thương lòng..." />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-black text-slate-400 uppercase">Thể loại</label>
            <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto p-2 border rounded-xl bg-slate-50 custom-scrollbar">
              {GENRES.map(g => (
                <button key={g} onClick={() => toggleGenre(g)} className={`px-2 py-1 text-[9px] rounded-md border transition-all ${params.genres.includes(g) ? 'bg-indigo-600 text-white border-indigo-600 shadow-md' : 'bg-white text-slate-500 border-slate-200 hover:border-indigo-200'}`}>{g}</button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-black text-slate-400 uppercase">Ý tưởng khởi nguồn</label>
            <textarea value={params.seed} onChange={e => setParams({...params, seed: e.target.value})} className="w-full h-24 p-3 text-xs bg-slate-50 border border-slate-200 rounded-xl outline-none resize-none font-medium focus:ring-1 focus:ring-indigo-300" placeholder="Nhập khởi nguồn..." />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-black text-slate-400 uppercase">Truyện mẫu / lưu ý văn phong</label>
            <textarea value={params.referenceStories} onChange={e => setParams({...params, referenceStories: e.target.value})} className="w-full h-20 p-3 text-xs bg-slate-50 border border-slate-200 rounded-xl outline-none resize-none font-medium focus:ring-1 focus:ring-indigo-300" placeholder="Ví dụ: nhịp chậm, ít giải thích, nhiều đối thoại, không copy tình tiết..." />
          </div>
          <button onClick={handleStartProject} disabled={isGeneratingOutline} className="btn-primary w-full py-4 font-black text-[10px] uppercase disabled:opacity-50">
            {isGeneratingOutline ? 'Đang thấu thị...' : (params.projectType === 'Truyện Ngắn' ? 'Viết truyện ngắn' : 'Lập lộ trình Arc')}
          </button>
        </div>
        <button onClick={() => setView('my-stories')} className="mt-auto py-3 px-4 bg-slate-50 rounded-lg border border-slate-200 text-[10px] font-black uppercase text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 transition-all flex items-center justify-between">
          <span>Tàng thư ({projects.length})</span>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
        </button>
        {activeProject && (
          <div className="p-4 bg-indigo-950 text-white rounded-lg shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-[8px] font-black uppercase text-indigo-200 tracking-widest">Đang mở</span>
                <span className="block text-xs font-black truncate">{activeProject.title}</span>
              </div>
              <span className="text-[10px] font-black">{progressPercent}%</span>
            </div>
            <div className="h-2 bg-white/15 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-300 rounded-full transition-all" style={{ width: `${Math.min(100, progressPercent)}%` }} />
            </div>
            <button onClick={(e) => handleExportManuscript(activeProject, e)} className="w-full py-2 bg-white/10 hover:bg-white/20 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all">
              Xuất bản thảo .txt
            </button>
          </div>
        )}
      </aside>

      <main className="flex-1 min-h-0 flex flex-col relative bg-transparent overflow-hidden">
        {generalSummary && (
          <nav className="h-14 bg-white border-b flex items-center px-4 md:px-8 gap-5 md:gap-8 z-10 shadow-sm shrink-0 overflow-x-auto no-scrollbar">
            <button onClick={() => setView('outline')} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'outline' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-300 hover:text-slate-500'}`}>Lộ trình Arc</button>
            <button onClick={() => setView('manuscript')} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'manuscript' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-300 hover:text-slate-500'}`}>Bản thảo ({writtenChapters.length})</button>
            <button onClick={() => setView('bible')} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'bible' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-300 hover:text-slate-500'}`}>Thiên Cơ Lục</button>
            <button onClick={openEditorWithGuard} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'editor' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-300 hover:text-slate-500'}`}>Chấp bút</button>
            <button onClick={handleReviewStoryLogic} disabled={isCheckingLogic || writtenChapters.length === 0} className="ml-auto px-4 py-2 bg-indigo-50 text-indigo-600 rounded-full text-[9px] font-black uppercase tracking-widest disabled:opacity-40 hover:bg-indigo-900 hover:text-white transition-all shrink-0">
              {isCheckingLogic ? 'Đang soi logic...' : 'Kiểm tra logic'}
            </button>
          </nav>
        )}

        <div className="workbench-grid flex-1 overflow-y-auto p-4 md:p-8 xl:p-10 custom-scrollbar">
          {view === 'setup' && (
            <div className="max-w-6xl mx-auto py-6 md:py-8 space-y-5 animate-in fade-in">
              <section className="surface p-5 md:p-6">
                <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-5">
                  <div className="max-w-3xl">
                    <div className="flex items-center gap-3 mb-4">
                      <span className="inline-flex px-2.5 py-1 bg-emerald-50 text-emerald-700 rounded-md text-[9px] font-black uppercase tracking-widest border border-emerald-100">Studio sáng tác</span>
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Quy trình khóa logic</span>
                    </div>
                    <h2 className="text-3xl md:text-4xl font-black text-slate-950 story-font leading-tight">
                      Bàn viết Bút Nghiên AI
                    </h2>
                    <p className="mt-3 text-sm md:text-base text-slate-600 leading-7">
                      Nhập hồ sơ ở bảng điều khiển bên trái. Hệ thống sẽ khóa Đại cục, Arc và Thiên Cơ Lục trước khi mở bước chấp bút, giúp truyện dài không lệch số liệu, không vỡ tuyến và không lan man.
                    </p>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3 shrink-0">
                    <button onClick={handleStartProject} disabled={isGeneratingOutline} className="btn-primary px-6 py-3 text-[10px] font-black uppercase tracking-widest disabled:opacity-50">
                      {isGeneratingOutline ? 'Đang dựng dự án...' : (params.projectType === 'Truyện Ngắn' ? 'Viết truyện ngắn' : 'Lập lộ trình')}
                    </button>
                    <button onClick={() => setView('my-stories')} className="btn-secondary px-6 py-3 text-[10px] font-black uppercase tracking-widest">
                      Mở Tàng Thư
                    </button>
                  </div>
                </div>
              </section>

              <section className="grid lg:grid-cols-[1fr_380px] gap-5 items-start">
                <div className="space-y-5">
                  <div className="grid sm:grid-cols-3 gap-3">
                    <div className="surface-muted p-4">
                      <span className="block text-[8px] font-black uppercase text-slate-400 tracking-widest">Dự án</span>
                      <strong className="block mt-2 text-lg font-black text-slate-950">{params.projectType}</strong>
                    </div>
                    <div className="surface-muted p-4 border-amber-200 bg-amber-50/80">
                      <span className="block text-[8px] font-black uppercase text-amber-700 tracking-widest">Lộ trình</span>
                      <strong className="block mt-2 text-lg font-black text-amber-950">{params.projectType === 'Trường Thiên' ? `${params.totalChapters} chương` : 'Truyện đơn'}</strong>
                    </div>
                    <div className="surface-muted p-4 border-indigo-200 bg-indigo-50/80">
                      <span className="block text-[8px] font-black uppercase text-indigo-600 tracking-widest">Mục tiêu</span>
                      <strong className="block mt-2 text-lg font-black text-indigo-950">{params.length} chữ</strong>
                    </div>
                  </div>

                  <div className="surface p-5">
                    <div className="flex items-center justify-between gap-4 mb-4">
                      <div>
                        <h3 className="text-xs font-black uppercase tracking-widest text-slate-900">Hồ sơ đầu vào</h3>
                        <p className="text-xs text-slate-500 mt-1">Những khóa chính AI đang dùng để dựng truyện.</p>
                      </div>
                      <span className={`px-2.5 py-1 rounded-md text-[9px] font-black uppercase ${planCompletenessPercent > 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>
                        {planCompletenessPercent}% sẵn sàng
                      </span>
                    </div>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div className="surface-muted p-4">
                        <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">Nhân vật</span>
                        <p className="mt-2 text-sm font-black text-slate-900">{params.character.name || 'Chưa đặt tên'}</p>
                        <p className="mt-1 text-xs text-slate-500 line-clamp-2">{params.character.personality || 'Chưa có tính cách khóa.'}</p>
                      </div>
                      <div className="surface-muted p-4">
                        <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">Mục tiêu nhân vật</span>
                        <p className="mt-2 text-xs text-slate-600 line-clamp-4">{params.character.goal || 'Chưa có mục tiêu hoặc vết thương lòng.'}</p>
                      </div>
                      <div className="surface-muted p-4">
                        <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">Thể loại</span>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {params.genres.slice(0, 6).map(genre => (
                            <span key={genre} className="px-2 py-1 rounded-md bg-white border border-slate-200 text-[9px] font-bold text-slate-600">{genre}</span>
                          ))}
                        </div>
                      </div>
                      <div className="surface-muted p-4">
                        <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">Văn phong</span>
                        <p className="mt-2 text-xs text-slate-600 line-clamp-4">{params.referenceStories || params.tone}</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-950 text-white rounded-lg p-5 shadow-sm space-y-5">
                  <div>
                    <span className="text-[9px] font-black uppercase text-emerald-300 tracking-widest">Luồng bắt buộc</span>
                    <h3 className="text-xl font-black story-font mt-2">Không chấp bút khi chưa khóa khung truyện</h3>
                  </div>
                  <div className="space-y-3">
                    {workflowSteps.map((step, idx) => (
                      <div key={step.label} className="grid grid-cols-[36px_1fr] gap-3 items-start">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-black ${step.status === 'done' ? 'bg-emerald-400 text-slate-950' : step.status === 'active' ? 'bg-amber-300 text-slate-950' : 'bg-white/10 text-slate-400'}`}>
                          {idx + 1}
                        </div>
                        <div className="pt-0.5">
                          <p className="text-sm font-black">{step.label}</p>
                          <p className="text-[10px] text-slate-400">{step.status === 'done' ? 'Đã sẵn sàng' : step.status === 'active' ? 'Đang cần hoàn thiện' : 'Chờ bước trước'}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  {roadmapIssues.length > 0 && (
                    <div className="p-4 bg-amber-300/10 border border-amber-300/20 rounded-lg">
                      <p className="text-[10px] font-black uppercase text-amber-200 mb-2">Còn thiếu</p>
                      <p className="text-xs text-amber-50 leading-relaxed">{roadmapIssues.join(' ')}</p>
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}

          {view === 'outline' && (
            <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in pb-20">
              <section className="p-6 bg-white border rounded-3xl shadow-sm border-l-4 border-l-indigo-600">
                <h3 className="text-[10px] font-black text-indigo-600 uppercase mb-2">Đại cục Trường Thiên</h3>
                <p className="story-font text-base italic text-slate-700 leading-relaxed">{generalSummary}</p>
              </section>
              <section className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="p-4 bg-white border border-slate-100 rounded-2xl shadow-sm">
                  <span className="block text-[8px] font-black uppercase text-slate-400 tracking-widest">Số chương</span>
                  <strong className="text-2xl font-black text-indigo-900">{plannedChapterIndexes.size}/{params.totalChapters}</strong>
                </div>
                <div className="p-4 bg-white border border-slate-100 rounded-2xl shadow-sm">
                  <span className="block text-[8px] font-black uppercase text-slate-400 tracking-widest">Arc</span>
                  <strong className="text-2xl font-black text-indigo-900">{volumes.length}</strong>
                </div>
                <div className="p-4 bg-white border border-slate-100 rounded-2xl shadow-sm">
                  <span className="block text-[8px] font-black uppercase text-slate-400 tracking-widest">Canon</span>
                  <strong className={`text-2xl font-black ${canonReadyCount === canonChecklist.length ? 'text-emerald-600' : 'text-amber-600'}`}>{canonReadyCount}/{canonChecklist.length}</strong>
                </div>
                <div className="p-4 bg-white border border-slate-100 rounded-2xl shadow-sm">
                  <span className="block text-[8px] font-black uppercase text-slate-400 tracking-widest">Trạng thái</span>
                  <strong className={`text-sm font-black ${hasRoadmapReady ? 'text-emerald-600' : 'text-red-500'}`}>
                    {hasRoadmapReady ? 'Sẵn sàng chấp bút' : 'Thiếu lộ trình'}
                  </strong>
                </div>
              </section>
              <section className={`p-5 rounded-3xl border shadow-sm ${hasRoadmapReady ? 'bg-emerald-50 border-emerald-100' : 'bg-amber-50 border-amber-100'}`}>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div>
                    <h3 className={`text-[10px] font-black uppercase tracking-widest ${hasRoadmapReady ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {hasRoadmapReady ? 'Quy trình đã khóa' : 'Cần hoàn thiện trước khi viết'}
                    </h3>
                    <p className="text-sm text-slate-700 mt-1">
                      {hasRoadmapReady
                        ? `Có ${plannedChapterIndexes.size} chương trong ${volumes.length} Arc. Đã sinh bản đồ chi tiết ${generatedChapterPlanCount} chương. Chương kế tiếp nên viết: ${firstUnwrittenChapterIndex ? `C.${firstUnwrittenChapterIndex}${firstUnwrittenPlan ? ` - ${firstUnwrittenPlan.title}` : ''}` : 'lộ trình đã hoàn tất'}.`
                        : roadmapIssues.join(' ')}
                    </p>
                  </div>
                  <button onClick={openEditorWithGuard} disabled={!hasRoadmapReady || !firstUnwrittenChapterIndex} className="px-6 py-3 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-900 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                    {firstUnwrittenChapterIndex ? 'Viết chương kế tiếp' : 'Đã đủ bản thảo'}
                  </button>
                </div>
              </section>
              <section className="p-6 bg-white border rounded-3xl shadow-sm border-l-4 border-l-slate-900">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
                  <h3 className="text-[10px] font-black text-slate-900 uppercase tracking-widest">Thiên Cơ Lục khởi tạo</h3>
                  <button onClick={() => setView('bible')} className="px-4 py-2 bg-slate-900 text-white rounded-xl text-[9px] font-black uppercase hover:bg-indigo-900 transition-all">
                    Mở đầy đủ
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 mb-4">
                  {canonChecklist.map(item => (
                    <span key={item.label} className={`px-3 py-1 rounded-full text-[8px] font-black uppercase border ${item.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-amber-50 text-amber-700 border-amber-100'}`}>
                      {item.label}: {item.ok ? 'OK' : 'Thiếu'}
                    </span>
                  ))}
                </div>
                <p className="story-font text-base text-slate-700 leading-relaxed whitespace-pre-wrap line-clamp-4">{worldBible || 'Thiên Cơ Lục sẽ xuất hiện sau khi lập lộ trình Arc.'}</p>
              </section>
              <div className="grid grid-cols-1 gap-8">
                {volumes && volumes.map((vol) => (
                  <div key={`vol-${vol.index}`} className="space-y-4">
                    <div className="bg-white p-6 rounded-3xl border shadow-sm border-t-4 border-t-indigo-100 flex flex-col gap-4">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-indigo-900 text-white rounded-xl flex items-center justify-center font-bold shadow-lg">{vol.index}</div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-black text-indigo-900 story-font text-xl uppercase tracking-tight">{vol.title}</h3>
                            {vol.chapterStart && vol.chapterEnd && (
                              <span className="px-2 py-1 bg-slate-100 text-slate-400 rounded-md text-[8px] font-black uppercase">C.{vol.chapterStart}-{vol.chapterEnd}</span>
                            )}
                          </div>
                          <p className="text-sm text-slate-500 italic mt-1">{vol.summary}</p>
                          {vol.purpose && <p className="text-[10px] text-indigo-500 font-bold mt-2 uppercase tracking-widest">{vol.purpose}</p>}
                        </div>
                      </div>
                      
                      {vol.chapters && vol.chapters.length > 0 && (
                        <div className="space-y-2 mt-4">
                          <h4 className="text-[9px] font-black uppercase text-slate-400 border-b pb-1">Bản đồ chương thuộc Arc này</h4>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {sortChapters(vol.chapters).map(chap => (
                              <div key={chap.index} className="p-4 bg-slate-50 border border-slate-100 rounded-2xl flex flex-col gap-3 group hover:border-indigo-200 transition-all shadow-sm">
                                <div>
                                  <span className="text-xs font-bold text-slate-700 line-clamp-1">C.{chap.index}: {chap.title}</span>
                                  <p className="text-[10px] text-slate-400 mt-1 line-clamp-2">{chap.objective || chap.summary}</p>
                                  <div className="flex gap-1 mt-2">
                                    <span className="px-2 py-0.5 bg-white rounded-md text-[8px] font-black text-slate-400 border">{chap.targetWords || params.length} chữ</span>
                                    <span className="px-2 py-0.5 bg-white rounded-md text-[8px] font-black text-slate-400 border">{chap.pacing || 'Nhịp vừa'}</span>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  {chap.content ? (
                                    <>
                                      <button onClick={() => handleReadChapter(chap, vol.index)} className="flex-1 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-[9px] font-black uppercase hover:bg-indigo-600 hover:text-white transition-all">Đọc</button>
                                      <button onClick={() => handleRewriteChapter(chap, vol.index)} className="flex-1 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-[9px] font-black uppercase hover:bg-slate-800 hover:text-white transition-all">Viết lại</button>
                                      <button onClick={(e) => handleDeleteChapter(chap.index, vol.index, e)} className="p-1.5 bg-red-50 text-red-400 rounded-lg hover:bg-red-600 hover:text-white transition-all">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                      </button>
                                    </>
                                  ) : (
                                    <button onClick={() => { if (!hasRoadmapReady) { alert('Chưa có đủ Thiên Cơ Lục và lộ trình Arc. Hãy lập lộ trình trước khi viết.'); return; } setActiveArcIndex(vol.index); setCurrentChapterIndex(chap.index); setChapterIdea(''); setStory(''); setView('editor'); }} className="flex-1 py-1.5 bg-indigo-900 text-white rounded-lg text-[9px] font-black uppercase hover:bg-black transition-all">Viết chương</button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <button 
                        onClick={() => handlePrepareWriteChapter(vol.index)}
                        className="w-full py-4 bg-indigo-50 text-indigo-600 rounded-xl font-black uppercase text-[10px] tracking-widest hover:bg-indigo-900 hover:text-white transition-all flex items-center justify-center gap-2 mt-2 shadow-sm"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
                        Viết chương theo lộ trình này
                      </button>
                    </div>
                  </div>
                ))}
                
                <button onClick={handleAddNextArc} disabled={isGeneratingOutline} className="w-full py-8 bg-slate-50 border-2 border-dashed border-slate-200 text-slate-400 rounded-3xl font-black uppercase text-[10px] tracking-widest hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-300 transition-all flex flex-col items-center gap-3 shadow-inner">
                  {isGeneratingOutline ? (generationStatus || 'Đang lập Arc mới...') : (
                    <>
                      <div className="w-10 h-10 bg-white border border-slate-100 rounded-full flex items-center justify-center shadow-sm">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
                      </div>
                      Tiếp tục vạch ra Arc kế tiếp
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {view === 'my-stories' && (
            <div className="max-w-5xl mx-auto space-y-8 animate-in slide-in-from-bottom-5">
              <section className="p-6 md:p-8 bg-indigo-900 text-white rounded-3xl shadow-xl flex flex-col md:flex-row md:justify-between md:items-center gap-4">
                <h2 className="text-2xl font-black italic story-font">Tàng Thư Của Bạn</h2>
                <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
                  <button onClick={() => fileInputRef.current?.click()} className="bg-white text-indigo-900 px-8 py-3 rounded-xl text-[10px] font-black uppercase shadow-lg hover:bg-slate-100 transition-all">Nhập file (.json)</button>
                </div>
                <input type="file" ref={fileInputRef} onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    try {
                      const imported = JSON.parse(ev.target?.result as string);
                      if (!isStoryProject(imported)) throw new Error('Không phải file dự án Bút Nghiên.');
                      const normalizedImport = normalizeProjectRecord(imported);
                      setProjects(prev => {
                          const existing = prev.find(p => p.id === normalizedImport.id);
                          if (existing) {
                              return prev.map(p => p.id === normalizedImport.id ? normalizedImport : p);
                          }
                          return [normalizedImport, ...prev];
                      });
                      saveProjectToDb(normalizedImport).catch(error => console.error("Không lưu được file nhập vào IndexedDB:", error));
                      saveProjectToFirebase(normalizedImport).catch(error => console.error("Không lưu được file nhập vào Firebase:", error));
                      alert("Đã đồng bộ tác phẩm thành công!");
                    } catch(e) { alert("File JSON không hợp lệ."); }
                  };
                  reader.readAsText(file);
                }} accept=".json" className="hidden" />
              </section>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {projects.map(p => (
                  <div key={p.id} className="p-8 bg-white border rounded-[2rem] hover:shadow-2xl transition-all group flex flex-col h-80 border-slate-100 shadow-sm">
                    <div className="flex-1">
                      <div className="flex justify-between items-start mb-4">
                        <span className="px-3 py-1 bg-indigo-50 text-indigo-600 rounded-full text-[9px] font-black uppercase">{p.params.projectType}</span>
                        <div className="flex gap-2">
                           <button onClick={(e) => handleExportManuscript(p, e)} className="p-2 bg-emerald-50 text-emerald-500 rounded-lg hover:bg-emerald-600 hover:text-white transition-all shadow-sm" title="Xuất bản thảo TXT">
                             <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" /></svg>
                           </button>
                           <button onClick={(e) => { e.stopPropagation(); const latestProj = projects.find(proj => proj.id === p.id) || p; const dataStr = JSON.stringify(latestProj, null, 2); const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr); const link = document.createElement('a'); link.href = dataUri; link.download = `ButNghien_${latestProj.title.replace(/\s+/g, '_')}.json`; link.click(); }} className="p-2 bg-indigo-50 text-indigo-400 rounded-lg hover:bg-indigo-600 hover:text-white transition-all shadow-sm" title="Xuất JSON">
                             <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                           </button>
                           <button onClick={(e) => handleDeleteProject(p.id, e)} className="p-2 bg-red-50 text-red-300 rounded-lg hover:bg-red-600 hover:text-white transition-all shadow-sm" title="Xóa dự án">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                           </button>
                        </div>
                      </div>
                      <h3 className="font-black text-xl uppercase text-slate-800 story-font group-hover:text-indigo-900 mb-2 line-clamp-1">{p.title}</h3>
                      <p className="text-[10px] text-slate-400 italic line-clamp-4 leading-relaxed">{p.generalSummary}</p>
                    </div>
                    <div className="flex gap-2 pt-6 border-t border-slate-50 mt-auto">
                      <button onClick={() => loadProject(p)} className="flex-1 py-3 bg-indigo-900 text-white rounded-xl text-[10px] font-black uppercase shadow-lg hover:bg-black transition-all">Mở dự án</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'editor' && (
            <div className="max-w-3xl mx-auto pb-48 animate-in fade-in">
              {params.projectType === 'Trường Thiên' && !hasRoadmapReady ? (
                <section className="p-8 md:p-10 bg-amber-50 border border-amber-100 rounded-[2rem] shadow-sm space-y-5">
                  <span className="inline-flex px-3 py-1 bg-white text-amber-700 rounded-full text-[9px] font-black uppercase tracking-widest">Chưa mở khóa chấp bút</span>
                  <h2 className="text-3xl font-black story-font text-slate-900">Cần hoàn thiện lộ trình trước</h2>
                  <div className="space-y-2">
                    {roadmapIssues.map(issue => (
                      <p key={issue} className="text-sm text-amber-800 font-bold">{issue}</p>
                    ))}
                  </div>
                  <button onClick={() => setView('outline')} className="px-7 py-3 bg-slate-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-900 transition-all">
                    Về lộ trình Arc
                  </button>
                </section>
              ) : !story || isGenerating ? (
                <section className="p-6 md:p-10 bg-white border rounded-[2rem] md:rounded-[3rem] shadow-2xl space-y-8 border-t-[12px] border-t-indigo-900 mt-6 md:mt-10 relative overflow-hidden">
                  <div className="text-center space-y-2">
                     <span className="text-[10px] font-black uppercase text-indigo-600 tracking-[0.3em]">Thiên Cơ Lệnh</span>
                     <h3 className="text-2xl md:text-3xl font-black italic story-font text-indigo-900">
                      Chương {currentChapterIndex} - {volumes.find(v => v.index === activeArcIndex)?.title}
                     </h3>
                     <p className="text-xs text-slate-400 italic">Mục tiêu Arc: {volumes.find(v => v.index === activeArcIndex)?.summary}</p>
                  </div>
                  {currentChapterPlan && (
                    <div className="p-5 bg-indigo-50/70 border border-indigo-100 rounded-2xl space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="text-xs font-black text-indigo-900 uppercase">{currentChapterPlan.title}</h4>
                        <span className="px-3 py-1 bg-white text-indigo-600 rounded-full text-[9px] font-black shadow-sm">{currentChapterPlan.targetWords || params.length} chữ</span>
                      </div>
                      <p className="text-xs text-indigo-700 leading-relaxed">{currentChapterPlan.objective || currentChapterPlan.summary}</p>
                      {!!currentChapterPlan.beats?.length && (
                        <div className="flex flex-wrap gap-2">
                          {currentChapterPlan.beats?.map((beat, idx) => (
                            <span key={idx} className="px-2 py-1 bg-white/80 text-indigo-500 rounded-md text-[9px] font-bold border border-indigo-100">{beat}</span>
                          ))}
                        </div>
                      )}
                      {!!currentChapterPlan.mustInclude?.length && (
                        <div className="pt-2 border-t border-indigo-100 flex flex-wrap gap-2">
                          {currentChapterPlan.mustInclude.map((item, idx) => (
                            <span key={idx} className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded-md text-[9px] font-bold border border-emerald-100">{item}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Ý đồ của chương (AI sẽ ưu tiên bám lộ trình Arc)</label>
                    <textarea 
                      value={chapterIdea} 
                      onChange={e => setChapterIdea(e.target.value)} 
                      placeholder="Nhập yêu cầu nếu muốn điều chỉnh lộ trình..." 
                      className="w-full h-48 p-5 md:p-8 bg-slate-50 border border-slate-100 rounded-3xl text-sm outline-none resize-none font-medium focus:bg-white focus:ring-4 focus:ring-indigo-50 transition-all shadow-inner" 
                    />
                  </div>
                  <button 
                    onClick={handleWriteChapter} 
                    disabled={isGenerating} 
                    className={`w-full py-6 rounded-full font-black uppercase text-xs shadow-2xl transition-all flex items-center justify-center gap-3 ${isGenerating ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-indigo-900 text-white hover:bg-black'}`}
                  >
                    {isGenerating ? (generationStatus || 'Đang triệu hồi câu chữ...') : `Khai bút Chương ${currentChapterIndex}`}
                  </button>
                </section>
              ) : (
                <div className="space-y-12 animate-in fade-in zoom-in-95 duration-700">
                  <header className="text-center space-y-6">
                    <div className="flex flex-col items-center gap-3">
                      <div className="px-4 py-1.5 bg-indigo-50 text-indigo-600 rounded-full text-[10px] font-black uppercase tracking-[0.2em] shadow-sm">
                        Số chữ: {getWordCount(story)} / mục tiêu {getChapterPlan(currentChapterIndex)?.targetWords || params.length}
                      </div>
                      <h2 className="text-3xl md:text-5xl font-black italic story-font text-slate-900 leading-tight">
                        {writtenChapters.find(c => c.index === currentChapterIndex)?.title || `Chương ${currentChapterIndex}`}
                      </h2>
                    </div>
                    <div className="flex flex-wrap justify-center gap-4">
                      <button onClick={handleWriteNextChapter} className="text-[10px] font-black uppercase text-indigo-600 bg-indigo-50 px-8 py-3 rounded-full hover:bg-indigo-100 transition-all shadow-sm">Viết Chương Tiếp Theo</button>
                      <button onClick={() => setView('outline')} className="text-[10px] font-black uppercase text-slate-400 border border-slate-200 px-8 py-3 rounded-full hover:bg-slate-50 transition-all">Về Lộ Trình</button>
                    </div>
                  </header>
                  <article className="story-font text-lg md:text-2xl leading-relaxed text-slate-800 whitespace-pre-wrap text-left md:text-justify shadow-2xl p-6 md:p-20 bg-white/95 rounded-[2rem] md:rounded-[3rem] border border-slate-50 relative">
                    {story}
                  </article>
                </div>
              )}
            </div>
          )}
          
          {view === 'bible' && (
             <div className="max-w-4xl mx-auto py-12 pb-32">
                <header className="mb-12 flex flex-col items-center gap-4">
                  <div className="w-16 h-16 bg-indigo-900 text-white rounded-2xl flex items-center justify-center shadow-2xl rotate-3">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                  </div>
                  <h2 className="text-4xl font-black italic text-indigo-900 story-font uppercase tracking-tighter">Thiên Cơ Lục</h2>
                  <p className="text-xs text-slate-400 uppercase font-black tracking-[0.4em]">Biên niên sử nhất quán với lộ trình</p>
                </header>
                {logicReport && (
                  <section className="mb-10 bg-white border border-indigo-100 rounded-3xl p-8 shadow-sm space-y-6">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <h3 className="text-[10px] font-black text-indigo-600 uppercase tracking-widest">Báo cáo logic truyện</h3>
                        <p className="story-font text-xl text-slate-800 mt-2 italic">{logicReport.summary}</p>
                      </div>
                      <div className="w-20 h-20 rounded-2xl bg-indigo-900 text-white flex flex-col items-center justify-center shadow-xl">
                        <span className="text-2xl font-black">{logicReport.score}</span>
                        <span className="text-[8px] font-bold uppercase">/100</span>
                      </div>
                    </div>
                    {logicReport.issues.length > 0 && (
                      <div className="space-y-3">
                        {logicReport.issues.map((issue, idx) => (
                          <div key={idx} className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                            <div className="flex items-center gap-2 mb-2">
                              <span className={`px-2 py-1 rounded-md text-[8px] font-black uppercase ${issue.severity === 'Cao' ? 'bg-red-100 text-red-600' : issue.severity === 'Vừa' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{issue.severity}</span>
                              {issue.chapter && <span className="text-[9px] font-black uppercase text-slate-400">Chương {issue.chapter}</span>}
                            </div>
                            <p className="text-sm font-bold text-slate-700">{issue.issue}</p>
                            <p className="text-xs text-slate-500 mt-1">{issue.fix}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="p-4 bg-indigo-50 rounded-2xl">
                        <h4 className="text-[9px] font-black uppercase text-indigo-600 mb-2">Gợi ý biên tập</h4>
                        <ul className="space-y-2">
                          {logicReport.suggestions.map((suggestion, idx) => (
                            <li key={idx} className="text-xs text-indigo-800 leading-relaxed">{suggestion}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="p-4 bg-slate-900 text-white rounded-2xl">
                        <h4 className="text-[9px] font-black uppercase text-indigo-200 mb-2">Trọng tâm chương tiếp theo</h4>
                        <p className="text-sm story-font leading-relaxed">{logicReport.nextChapterFocus}</p>
                      </div>
                    </div>
                  </section>
                )}
                {renderBibleContent(worldBible)}
             </div>
          )}
          
          {view === 'manuscript' && (
             <div className="max-w-4xl mx-auto space-y-4 pb-20">
               <div className="flex justify-between items-center mb-6">
                 <h2 className="text-3xl font-black italic story-font text-indigo-900">Bản thảo lưu trữ</h2>
                 <span className="px-4 py-1 bg-slate-100 text-slate-500 rounded-full text-[10px] font-black">{writtenChapters.length} Chương</span>
               </div>
               {sortChapters(writtenChapters).map(c => {
                   const parentVol = volumes.find(v => (v.chapters || []).some(ch => ch.index === c.index));
                   return (
                     <div key={c.index} className="p-6 md:p-8 bg-white border rounded-[2rem] flex flex-col md:flex-row md:justify-between md:items-center gap-4 group shadow-sm hover:shadow-xl transition-all">
                       <div className="flex flex-col gap-2">
                         <span className="text-[10px] font-black uppercase text-indigo-400 tracking-widest">Chương {c.index} ({getWordCount(c.content || "")} chữ)</span>
                         <h4 className="font-black text-slate-800 story-font text-xl uppercase tracking-tight">{c.title}</h4>
                       </div>
                       <div className="flex flex-wrap items-center gap-2">
                         <button onClick={() => handleReadChapter(c, parentVol?.index || activeArcIndex)} className="px-6 py-3 bg-indigo-50 text-indigo-600 rounded-xl text-[10px] font-black uppercase hover:bg-indigo-900 hover:text-white transition-all shadow-sm">Đọc</button>
                         <button onClick={() => handleRewriteChapter(c, parentVol?.index || activeArcIndex)} className="px-6 py-3 bg-slate-50 text-slate-500 rounded-xl text-[10px] font-black uppercase hover:bg-slate-800 hover:text-white transition-all shadow-sm">Viết lại</button>
                         <button onClick={(e) => handleDeleteChapter(c.index, parentVol?.index || activeArcIndex, e)} className="p-3 bg-red-50 text-red-400 rounded-xl hover:bg-red-600 hover:text-white transition-all">
                           <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                         </button>
                       </div>
                     </div>
                   );
                 })
               }
             </div>
          )}
        </div>
      </main>
      
      {(isGenerating || isGeneratingOutline || isCheckingLogic) && (
        <div className="fixed bottom-10 right-10 bg-slate-900 text-white px-8 py-5 rounded-3xl shadow-2xl flex items-center gap-5 z-50 animate-in slide-in-from-right-5">
          <div className="w-3 h-3 bg-indigo-500 rounded-full animate-ping"></div>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-white uppercase tracking-widest">{isGenerating ? 'Chấp bút...' : isCheckingLogic ? 'Soi logic...' : 'Thấu thị...'}</span>
            <span className="text-[9px] text-indigo-300 font-medium">{generationStatus}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
