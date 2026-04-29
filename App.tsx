
import { 
  generateInitialRoadmap, 
  generateNextArc, 
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
  getFirebaseProjectId,
  isFirebaseConfigured,
  loadProjectsFromFirebase,
  saveProjectToFirebase,
  saveProjectsToFirebase,
} from './services/firebaseService';
import { syncProjectsToGitHub } from './services/githubSyncService';
import React, { useState, useEffect, useRef } from 'react';
import { GENRES, TONES, MODES } from './constants';
import { StoryParams, StoryProject, Genre, Chapter, Volume, StoryLogicReport } from './types';

const MIN_TOTAL_CHAPTERS = 1;
const MAX_TOTAL_CHAPTERS = 300;
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
  lastChapterWritten: project.lastChapterWritten || (project.volumes || []).flatMap(volume => volume.chapters || []).filter(chapter => chapter.content).length,
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
  const [isSyncingGitHub, setIsSyncingGitHub] = useState<boolean>(false);
  const [githubSyncStatus, setGithubSyncStatus] = useState<string>('GitHub chưa đồng bộ');
  const [lastGitHubSyncUrl, setLastGitHubSyncUrl] = useState<string>('');
  const [isCheckingLogic, setIsCheckingLogic] = useState<boolean>(false);
  const [logicReport, setLogicReport] = useState<StoryLogicReport | null>(null);
  const [view, setView] = useState<'editor' | 'outline' | 'manuscript' | 'setup' | 'my-stories' | 'bible'>('setup');

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
        if (isFirebaseConfigured()) {
          try {
            const firebaseProjects = (await loadProjectsFromFirebase()).map(normalizeProjectRecord);
            if (cancelled) return;

            if (firebaseProjects.length > 0) {
              setProjects(firebaseProjects);
              await replaceAllProjectsInDb(firebaseProjects);
              setStorageStatus(`IndexedDB đã lưu cache ${firebaseProjects.length} tác phẩm`);
              setCloudStatus(`Firebase đã tải ${firebaseProjects.length} tác phẩm từ ${getFirebaseProjectId()}`);
              return;
            }

            setCloudStatus('Firebase trống, sẽ đồng bộ từ dữ liệu local nếu có');
          } catch (firebaseError) {
            console.warn(firebaseError);
            if (!cancelled) setCloudStatus('Firebase chưa sẵn sàng, đang dùng dữ liệu local');
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
  }, []);

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
  }, [projects, isHydrated]);

  const toggleGenre = (genre: Genre) => {
    setParams(prev => ({
      ...prev,
      genres: prev.genres.includes(genre) ? prev.genres.filter(g => g !== genre) : [...prev.genres, genre]
    }));
  };

  const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const normalizeParams = (draft: StoryParams): StoryParams => ({
    ...draft,
    totalChapters: clampNumber(Math.round(Number(draft.totalChapters) || 1), MIN_TOTAL_CHAPTERS, MAX_TOTAL_CHAPTERS),
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
  });

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
    if (message.includes('400')) return 'Gemini từ chối request. Kiểm tra lại tên model, GEMINI_MAX_OUTPUT_TOKENS hoặc giảm độ dài chương.';
    if (message.includes('403') || message.includes('401')) return 'Gemini API key không hợp lệ hoặc chưa được cấp quyền dùng API.';
    if (message.includes('JSON')) return 'AI trả về dữ liệu không đúng định dạng. Hãy thử lại hoặc giảm số chương để lộ trình gọn hơn.';
    if (message.includes('Failed to fetch')) return 'Không kết nối được Gemini API. Kiểm tra mạng hoặc CORS/trình duyệt.';
    return message || 'Có lỗi không xác định.';
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

  const getActiveArc = () => volumes.find(v => v.index === activeArcIndex);
  const getChapterPlan = (chapterIndex: number, arcIndex = activeArcIndex) =>
    volumes.find(v => v.index === arcIndex)?.chapters?.find(ch => ch.index === chapterIndex);
  const activeProject = projects.find(project => project.id === activeProjectId);
  const plannedChapterCount = volumes.reduce((total, volume) => total + (volume.chapters?.length || 0), 0);
  const progressPercent = plannedChapterCount > 0 ? Math.round((writtenChapters.length / plannedChapterCount) * 100) : 0;
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

  const friendlySyncError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('GITHUB_SYNC_TOKEN')) return 'Vercel chưa có GITHUB_SYNC_TOKEN. Hãy thêm token GitHub có quyền Contents: Read and write.';
    if (message.includes('GITHUB_SYNC_REPO')) return 'Vercel chưa có GITHUB_SYNC_REPO đúng dạng owner/repository.';
    if (message.includes('GitHub 401') || message.includes('GitHub 403')) return 'GitHub token không hợp lệ hoặc chưa có quyền ghi vào repo.';
    if (message.includes('GitHub 404')) return 'Không tìm thấy repo/branch GitHub. Kiểm tra GITHUB_SYNC_REPO và GITHUB_SYNC_BRANCH.';
    if (message.includes('Chua co API') || message.includes('Unexpected token')) return 'Đồng bộ GitHub chỉ chạy khi deploy trên Vercel hoặc chạy local bằng vercel dev.';
    return message || 'Không đồng bộ được GitHub.';
  };

  const handleSyncToGitHub = async (scope: 'active' | 'all', e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (isSyncingGitHub) return;
    const syncTargets = scope === 'all' ? projects : (activeProject ? [activeProject] : []);
    if (syncTargets.length === 0) {
      alert(scope === 'all' ? 'Chưa có tác phẩm để đồng bộ.' : 'Hãy mở một tác phẩm trước khi đồng bộ.');
      return;
    }

    setIsSyncingGitHub(true);
    setGithubSyncStatus(scope === 'all' ? 'Đang đồng bộ toàn bộ Tàng Thư lên GitHub...' : 'Đang đồng bộ tác phẩm đang mở lên GitHub...');
    try {
      const result = await syncProjectsToGitHub(syncTargets);
      setGithubSyncStatus(`Đã lưu ${result.files.length} file vào ${result.repo}`);
      setLastGitHubSyncUrl(result.commitUrl);
      alert(`Đã đồng bộ lên GitHub: ${result.repo}\nSố file: ${result.files.length}`);
    } catch (error) {
      const message = friendlySyncError(error);
      setGithubSyncStatus(message);
      alert(message);
    } finally {
      setIsSyncingGitHub(false);
    }
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

    setIsGenerating(true);
    setStory('');
    
    let attempts = 0;
    const maxAttempts = 2;
    let isValid = false;
    let finalContent = "";

    try {
      const currentArc = getActiveArc() || { index: activeArcIndex, title: 'Tự do', summary: 'Không có lộ trình cụ thể.', chapters: [] };
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

        setGenerationStatus('Đang thẩm định số chữ, logic và độ bám lộ trình...');
        const validation = await validateChapterLogic(finalContent, previousForValidation, worldBible, currentArc, generalSummary, params, currentChapterIndex);
        
        if (validation.isValid) {
          isValid = true;
        } else {
          console.warn("Lệch lộ trình:", validation.reason);
          if (attempts < maxAttempts) {
            setStory(''); 
          }
        }
      }

      if (!isValid) {
        alert("Lưu ý: Chương này vẫn có điểm cần biên tập thêm, nhưng hệ thống đã thử viết lại theo lộ trình tốt nhất có thể.");
      }

      setGenerationStatus('Đang cập nhật Thiên Cơ Lục...');
      const updates = await updateWorldBibleAndSummary(worldBible, finalContent, currentChapterIndex, generalSummary, params, currentArc);
      
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

      const updatedVolumes = volumes.map(v => {
        if (v.index === activeArcIndex) {
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
        ? { ...p, volumes: updatedVolumes, progressionSummary: updates.updatedBible, lastChapterWritten: nextWrittenList.length, updatedAt: Date.now() }
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
    setGenerationStatus('Đang thấu thị đại cục và lập bản đồ chương...');
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
        setGeneralSummary(params.seed || '');
        setWorldBible('Truyện ngắn hoàn chỉnh.');
        setCurrentChapterIndex(1);
        setActiveArcIndex(1);
        setStory(extracted.body);
      } else {
        const result = await generateInitialRoadmap(workingParams);
        if (!result || !result.volumes?.length) throw new Error("Dữ liệu lộ trình không hợp lệ.");
        const initialVolumes = result.volumes;
        setVolumes(initialVolumes);
        setWrittenChapters([]);
        setGeneralSummary(result.generalSummary || workingParams.seed);
        setWorldBible(result.worldBuilding || 'Thiên cơ đang thành hình...');
        setCurrentChapterIndex(1);
        setActiveArcIndex(1);
        const newId = Date.now().toString();
        const newProj: StoryProject = {
          id: newId,
          title: result.title || projectTitleFromSeed(workingParams.seed),
          params: workingParams,
          generalSummary: result.generalSummary || workingParams.seed,
          progressionSummary: result.worldBuilding || '',
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
      const updatedVolumes = [...volumes, nextVol];
      setVolumes(updatedVolumes);
      setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, volumes: updatedVolumes, updatedAt: Date.now() } : p));
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

  const handlePrepareWriteChapter = (arcIndex: number) => {
    setActiveArcIndex(arcIndex);
    const arc = volumes.find(v => v.index === arcIndex);
    const firstUnwritten = sortChapters(arc?.chapters || []).find(ch => !writtenChapters.some(written => written.index === ch.index));
    const nextIdx = firstUnwritten?.index || (writtenChapters.length > 0 ? Math.max(...writtenChapters.map(c => c.index)) + 1 : 1);
    setCurrentChapterIndex(nextIdx);
    setChapterIdea(''); setStory(''); setView('editor');
  };

  const handleReadChapter = (chapter: Chapter, arcIndex: number) => {
    setStory(chapter.content || ''); setCurrentChapterIndex(chapter.index); setActiveArcIndex(arcIndex); setView('editor');
  };

  const handleRewriteChapter = (chapter: Chapter, arcIndex: number) => {
    setCurrentChapterIndex(chapter.index); setActiveArcIndex(arcIndex); setChapterIdea(''); setStory(''); setView('editor');
  };

  const handleDeleteChapter = (chapterIndex: number, arcIndex: number, e: React.MouseEvent) => {
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
        ? { ...p, volumes: updatedVolumes, lastChapterWritten: nextWrittenList.length, updatedAt: Date.now() }
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
    setWrittenChapters(loadedWritten); setWorldBible(p.progressionSummary || ''); setGeneralSummary(p.generalSummary || '');
    setActiveArcIndex(loadedVolumes[0]?.index || 1);
    setCurrentChapterIndex(loadedWritten[0]?.index || 1);
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

  return (
    <div className="flex flex-col md:flex-row h-screen bg-[#f8f5f2] overflow-hidden text-slate-800 font-sans">
      <aside className="w-full md:w-80 max-h-[48vh] md:max-h-none bg-white border-b md:border-b-0 md:border-r border-slate-200 p-4 md:p-6 flex flex-col gap-4 md:gap-5 shrink-0 shadow-xl z-20 overflow-y-auto custom-scrollbar">
        <div className="flex items-center gap-3 pb-4 border-b">
          <div className="w-10 h-10 bg-indigo-900 text-white rounded-xl flex items-center justify-center font-black italic">BN</div>
          <h1 onClick={() => setView('setup')} className="text-xl font-black text-indigo-900 cursor-pointer italic hover:text-indigo-600 transition-all">Bút Nghiên AI</h1>
        </div>
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
        <div className="p-3 bg-slate-50 rounded-xl border border-slate-100 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block text-[8px] font-black uppercase text-slate-400">GitHub Sync</span>
              <span className="block text-[9px] font-bold text-slate-500 line-clamp-2">{githubSyncStatus}</span>
            </div>
            <button onClick={(e) => handleSyncToGitHub('all', e)} disabled={isSyncingGitHub || projects.length === 0} className="px-3 py-2 bg-indigo-900 text-white rounded-lg text-[8px] font-black uppercase disabled:opacity-40 hover:bg-black transition-all shrink-0">
              {isSyncingGitHub ? 'Đang gửi' : 'Sync'}
            </button>
          </div>
          {lastGitHubSyncUrl && (
            <a href={lastGitHubSyncUrl} target="_blank" rel="noreferrer" className="block text-[9px] font-black uppercase text-indigo-500 hover:text-indigo-900">
              Mở commit mới nhất
            </a>
          )}
        </div>
        
        <div className="space-y-5">
          <div className="flex bg-slate-100 p-1 rounded-xl">
            {(['Truyện Ngắn', 'Trường Thiên'] as const).map(t => (
              <button key={t} onClick={() => setParams({...params, projectType: t})} className={`flex-1 py-2 text-[10px] font-bold uppercase rounded-lg transition-all ${params.projectType === t ? 'bg-white shadow text-indigo-600' : 'text-slate-400'}`}>{t}</button>
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

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase">Số chương</label>
              <input type="number" min={MIN_TOTAL_CHAPTERS} max={MAX_TOTAL_CHAPTERS} value={params.totalChapters} onChange={e => setParams({...params, totalChapters: parseInt(e.target.value) || 1})} className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold focus:ring-1 focus:ring-indigo-300 outline-none" />
            </div>
            <div className="space-y-1">
              <label className="text-[9px] font-black text-slate-400 uppercase">Số chữ/Chương</label>
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
          <button onClick={handleStartProject} disabled={isGeneratingOutline} className="w-full py-4 bg-indigo-900 text-white rounded-2xl font-black text-[10px] uppercase hover:bg-black transition-all shadow-lg">
            {isGeneratingOutline ? 'Đang thấu thị...' : (params.projectType === 'Truyện Ngắn' ? 'Viết truyện ngắn' : 'Lập bản đồ chương')}
          </button>
        </div>
        <button onClick={() => setView('my-stories')} className="mt-auto py-3 px-4 bg-slate-50 rounded-xl text-[10px] font-black uppercase text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 transition-all flex items-center justify-between">
          <span>Tàng thư ({projects.length})</span>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
        </button>
        {activeProject && (
          <div className="p-4 bg-indigo-950 text-white rounded-2xl shadow-xl space-y-3">
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
            <button onClick={(e) => handleSyncToGitHub('active', e)} disabled={isSyncingGitHub} className="w-full py-2 bg-indigo-300 text-indigo-950 hover:bg-white rounded-xl text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-50">
              {isSyncingGitHub ? 'Đang đồng bộ...' : 'Đồng bộ tác phẩm lên GitHub'}
            </button>
          </div>
        )}
      </aside>

      <main className="flex-1 min-h-0 flex flex-col relative bg-[#fefcfb] overflow-hidden">
        {generalSummary && (
          <nav className="h-14 bg-white border-b flex items-center px-4 md:px-8 gap-5 md:gap-8 z-10 shadow-sm shrink-0 overflow-x-auto no-scrollbar">
            <button onClick={() => setView('outline')} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'outline' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-300 hover:text-slate-500'}`}>Lộ trình Arc</button>
            <button onClick={() => setView('manuscript')} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'manuscript' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-300 hover:text-slate-500'}`}>Bản thảo ({writtenChapters.length})</button>
            <button onClick={() => setView('bible')} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'bible' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-300 hover:text-slate-500'}`}>Thiên Cơ Lục</button>
            <button onClick={() => setView('editor')} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'editor' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-300 hover:text-slate-500'}`}>Chấp bút</button>
            <button onClick={handleReviewStoryLogic} disabled={isCheckingLogic || writtenChapters.length === 0} className="ml-auto px-4 py-2 bg-indigo-50 text-indigo-600 rounded-full text-[9px] font-black uppercase tracking-widest disabled:opacity-40 hover:bg-indigo-900 hover:text-white transition-all shrink-0">
              {isCheckingLogic ? 'Đang soi logic...' : 'Kiểm tra logic'}
            </button>
          </nav>
        )}

        <div className="flex-1 overflow-y-auto p-4 md:p-12 custom-scrollbar bg-[url('https://www.transparenttextures.com/patterns/paper.png')]">
          {view === 'setup' && (
            <div className="max-w-2xl mx-auto py-16 md:py-32 text-center space-y-6">
              <h2 className="text-4xl md:text-6xl font-black text-slate-900 italic story-font leading-tight">Bút Nghiên <span className="text-indigo-600 not-italic">Thiên Cơ</span></h2>
              <p className="text-xl text-slate-400 italic story-font">Hệ thống hỗ trợ sáng tác chuyên nghiệp với tính nhất quán lộ trình tuyệt đối.</p>
              <button onClick={() => setView('my-stories')} className="px-8 py-3 bg-indigo-900 text-white rounded-full text-xs font-black uppercase tracking-widest shadow-xl hover:bg-black transition-all">Khám phá Tàng Thư</button>
            </div>
          )}

          {view === 'outline' && (
            <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in pb-20">
              <section className="p-6 bg-white border rounded-3xl shadow-sm border-l-4 border-l-indigo-600">
                <h3 className="text-[10px] font-black text-indigo-600 uppercase mb-2">Đại cục Trường Thiên</h3>
                <p className="story-font text-base italic text-slate-700 leading-relaxed">{generalSummary}</p>
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
                                    <button onClick={() => { setActiveArcIndex(vol.index); setCurrentChapterIndex(chap.index); setChapterIdea(''); setStory(''); setView('editor'); }} className="flex-1 py-1.5 bg-indigo-900 text-white rounded-lg text-[9px] font-black uppercase hover:bg-black transition-all">Viết chương</button>
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
                  <button onClick={(e) => handleSyncToGitHub('all', e)} disabled={isSyncingGitHub || projects.length === 0} className="bg-indigo-300 text-indigo-950 px-6 py-3 rounded-xl text-[10px] font-black uppercase shadow-lg hover:bg-white transition-all disabled:opacity-50">
                    {isSyncingGitHub ? 'Đang đồng bộ...' : 'Đồng bộ GitHub'}
                  </button>
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
              {!story || isGenerating ? (
                <section className="p-6 md:p-10 bg-white border rounded-[2rem] md:rounded-[3rem] shadow-2xl space-y-8 border-t-[12px] border-t-indigo-900 mt-6 md:mt-10 relative overflow-hidden">
                  <div className="text-center space-y-2">
                     <span className="text-[10px] font-black uppercase text-indigo-600 tracking-[0.3em]">Thiên Cơ Lệnh</span>
                     <h3 className="text-2xl md:text-3xl font-black italic story-font text-indigo-900">
                      Chương {currentChapterIndex} - {volumes.find(v => v.index === activeArcIndex)?.title}
                     </h3>
                     <p className="text-xs text-slate-400 italic">Mục tiêu Arc: {volumes.find(v => v.index === activeArcIndex)?.summary}</p>
                  </div>
                  {getChapterPlan(currentChapterIndex) && (
                    <div className="p-5 bg-indigo-50/70 border border-indigo-100 rounded-2xl space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="text-xs font-black text-indigo-900 uppercase">{getChapterPlan(currentChapterIndex)?.title}</h4>
                        <span className="px-3 py-1 bg-white text-indigo-600 rounded-full text-[9px] font-black shadow-sm">{getChapterPlan(currentChapterIndex)?.targetWords || params.length} chữ</span>
                      </div>
                      <p className="text-xs text-indigo-700 leading-relaxed">{getChapterPlan(currentChapterIndex)?.objective || getChapterPlan(currentChapterIndex)?.summary}</p>
                      {!!getChapterPlan(currentChapterIndex)?.beats?.length && (
                        <div className="flex flex-wrap gap-2">
                          {getChapterPlan(currentChapterIndex)?.beats?.map((beat, idx) => (
                            <span key={idx} className="px-2 py-1 bg-white/80 text-indigo-500 rounded-md text-[9px] font-bold border border-indigo-100">{beat}</span>
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
                      <button onClick={() => { 
                        const allPlans = sortChapters(volumes.flatMap(v => v.chapters || []));
                        const nextPlan = allPlans.find(ch => ch.index > currentChapterIndex && !writtenChapters.some(w => w.index === ch.index));
                        const max = writtenChapters.length > 0 ? Math.max(...writtenChapters.map(c => c.index)) : 0;
                        setCurrentChapterIndex(nextPlan?.index || max + 1);
                        const nextArc = nextPlan ? volumes.find(v => (v.chapters || []).some(ch => ch.index === nextPlan.index)) : undefined;
                        if (nextArc) setActiveArcIndex(nextArc.index);
                        setStory(''); 
                      }} className="text-[10px] font-black uppercase text-indigo-600 bg-indigo-50 px-8 py-3 rounded-full hover:bg-indigo-100 transition-all shadow-sm">Viết Chương Tiếp Theo</button>
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
