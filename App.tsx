
import { 
  generateInitialRoadmap, 
  generateNextArc, 
  generateChapterPlansForArc,
  generateChapterStream, 
  rewriteChapterWithReviewStream,
  updateWorldBibleAndSummary,
  detectDraftRepetition,
  refreshGeneralSummary, 
  generateShortStoryStream,
  generateStoryDirectionChoices,
  validateChapterLogic,
  reviewStoryLogic,
  getConfiguredGeminiKeyCount,
  getGeminiKeyStatusLabel,
  type ChapterValidationResult
} from './services/geminiService';
import {
  deleteProjectFromDb,
  loadProjectsFromDb,
  replaceAllProjectsInDb,
  saveProjectToDb,
} from './services/databaseService';
import { readLocalTombstones, persistLocalTombstones, writeLocalTombstone, clearLocalTombstone, applyTombstones, TombstoneMap } from './services/tombstoneStore';
import { countWords, clamp, isLikelyCutOffText, stripDirectionLabels, splitSentencesForSpeech } from './services/textUtils';
import { SpeechPlayer, SpeechPlayerState, SpeechEngineKind, TtsVoiceOption } from './services/ttsService';
import { planAutoWriteChapters, nextInReadQueue } from './services/autoSession';
import {
  deleteProjectFromFirebase,
  loadDeletedProjectIdsFromFirebase,
  recordDeletedProjectOnFirebase,
  clearDeletedProjectOnFirebase,
  type FirebaseAuthUser,
  getFirebaseProjectId,
  getStoredFirebaseUser,
  isFirebaseConfigured,
  loadProjectsFromFirebaseDetailed,
  saveProjectsToFirebase,
  signInToFirebase,
  signOutFromFirebase,
} from './services/firebaseService';
import React, { useState, useEffect, useRef } from 'react';
import { GENRES, TONES, MODES } from './constants';
import { StoryParams, StoryProject, Genre, Tone, Chapter, Volume, StoryLogicReport, StoryDirectionChoice } from './types';

const MIN_TOTAL_CHAPTERS = 1;
const MAX_TOTAL_CHAPTERS = 1000;
const MIN_CHAPTER_WORDS = 300;
const MAX_CHAPTER_WORDS = 20000;

const DEFAULT_PARAMS: StoryParams = {
  projectType: 'Trường Thiên',
  totalChapters: 50,
  length: 2000,
  genres: [],
  tone: 'Kịch tính',
  narrativeView: 'Ngôi thứ ba hạn chế bám nhân vật chính',
  character: { name: '', gender: 'Không xác định', personality: '', goal: '' },
  sliders: { romance: 0, violence: 0, philosophy: 0, psychology: 0, action: 0, strategy: 0 },
  mode: 'Truyện hoàn chỉnh',
  seed: '',
  referenceStories: '',
  directionLock: ''
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

const mergeProjectsByUpdatedAt = (local: StoryProject[], cloud: StoryProject[]): StoryProject[] => {
  const byId = new Map<string, StoryProject>();
  for (const project of local) byId.set(project.id, project);
  for (const project of cloud) {
    const current = byId.get(project.id);
    if (!current || (project.updatedAt || 0) >= (current.updatedAt || 0)) byId.set(project.id, project);
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};

// Gập dấu tiếng Việt + thường hóa để tìm kiếm không dấu trong bản thảo.
const foldText = (value: string) => String(value || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d");

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
  const [isRetryingBible, setIsRetryingBible] = useState<boolean>(false);
  const [manuscriptQuery, setManuscriptQuery] = useState('');
  const [ttsSession, setTtsSession] = useState<{ chapterIndex: number; title: string; total: number } | null>(null);
  const [ttsState, setTtsState] = useState<SpeechPlayerState>('idle');
  const [ttsIndex, setTtsIndex] = useState(0);
  const [ttsEngine, setTtsEngine] = useState<SpeechEngineKind>('browser');
  const [ttsRate, setTtsRateState] = useState(1);
  const [ttsVoiceId, setTtsVoiceId] = useState('');
  const [ttsVoices, setTtsVoices] = useState<TtsVoiceOption[]>([]);
  const [ttsSegmentText, setTtsSegmentText] = useState('');
  const speechPlayerRef = useRef<SpeechPlayer | null>(null);
  const [autoSession, setAutoSession] = useState<{ running: boolean; phase: string; message: string; writingIndex: number | null; readingIndex: number | null; writtenThisSession: number[]; targetCount: number } | null>(null);
  const [autoWriteEnabled, setAutoWriteEnabled] = useState(true);
  const [autoReadEnabled, setAutoReadEnabled] = useState(true);
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(true);
  const [autoChapterLimit, setAutoChapterLimit] = useState(5);
  const [autoReadFrom, setAutoReadFrom] = useState(0);
  const autoStopRef = useRef(false);
  const autoRunningRef = useRef(false);
  const autoWriterDoneRef = useRef(true);
  const autoReadQueueRef = useRef<number[]>([]);
  const autoReadDoneRef = useRef<Set<number>>(new Set());
  const autoReaderActiveRef = useRef(false);
  const autoReadingIndexRef = useRef<number | null>(null);
  const playerWaitersRef = useRef<Array<() => void>>([]);
  const [expandedPreviousChapter, setExpandedPreviousChapter] = useState<number | null>(null);
  const [includeBibleInExport, setIncludeBibleInExport] = useState(false);
  const [syncNonce, setSyncNonce] = useState(0);
  const [storageUsageText, setStorageUsageText] = useState('');
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
  const [directionChoices, setDirectionChoices] = useState<StoryDirectionChoice[]>([]);
  const [pendingDirectionParams, setPendingDirectionParams] = useState<StoryParams | null>(null);
  const [selectedDirectionId, setSelectedDirectionId] = useState<string>('');
  const [pendingDraftMeta, setPendingDraftMeta] = useState<{ chapterIndex: number; arcIndex: number } | null>(null);
  const [draftAutosavedMeta, setDraftAutosavedMeta] = useState<{ chapterIndex: number; arcIndex: number } | null>(null);
  const [draftReview, setDraftReview] = useState<ChapterValidationResult | null>(null);
  const [revisionRequest, setRevisionRequest] = useState<string>('');
  const [view, setView] = useState<'editor' | 'outline' | 'manuscript' | 'setup' | 'directions' | 'my-stories' | 'bible' | 'player'>('setup');
  const volumesRef = useRef<Volume[]>([]);
  const writtenChaptersRef = useRef<Chapter[]>([]);
  const worldBibleRef = useRef<string>('');
  const tombstonesRef = useRef<TombstoneMap>(readLocalTombstones());
  const lastSavedToDbRef = useRef<Map<string, number>>(new Map());
  const lastPushedRef = useRef<Map<string, number>>(new Map());
  const cloudLoadFailedRef = useRef(false);
  useEffect(() => { volumesRef.current = volumes; }, [volumes]);
  useEffect(() => { writtenChaptersRef.current = writtenChapters; }, [writtenChapters]);

  const clearDraftPipeline = () => {
    setPendingDraftMeta(null);
    setDraftAutosavedMeta(null);
    setDraftReview(null);
    setRevisionRequest('');
  };

  const updateDraftParams = (updater: (previous: StoryParams) => StoryParams) => {
    if (activeProjectId) {
      // Dang mo mot du an: sua ho so chi cap nhat ho so cua chinh du an do,
      // khong con xoa sach workspace/ban nhap chi vi go mot ky tu o form thiet lap.
      setParams(previous => {
        const next = { ...updater(previous) };
        setProjects(prevProjects => prevProjects.map(project => project.id === activeProjectId
          ? { ...project, params: next, updatedAt: Date.now() }
          : project
        ));
        return next;
      });
      return;
    }
    clearDraftPipeline();
    setDirectionChoices([]);
    setPendingDirectionParams(null);
    setSelectedDirectionId('');
    setLogicReport(null);
    setActiveProjectId(null);
    setVolumes([]);
    setWrittenChapters([]);
    setGeneralSummary('');
    setWorldBible('');
    setStory('');
    setChapterIdea('');
    setCurrentChapterIndex(1);
    setActiveArcIndex(1);
    setParams(previous => ({
      ...updater(previous),
      directionLock: '',
    }));
  };

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
            const detailed = await loadProjectsFromFirebaseDetailed();
            if (cancelled) return;
            const firebaseProjects = detailed.projects.map(normalizeProjectRecord);
            const localProjects = (await loadProjectsFromDb()).map(normalizeProjectRecord);
            try {
              const cloudTombstones = await loadDeletedProjectIdsFromFirebase();
              Object.entries(cloudTombstones).forEach(([id, ts]) => {
                const time = Number(ts) || 0;
                if (time > (tombstonesRef.current[id] || 0)) tombstonesRef.current[id] = time;
              });
              persistLocalTombstones(tombstonesRef.current);
            } catch { /* tombstone cloud la lop phu — loi thi dung ban local */ }
            const mergedProjects = applyTombstones(mergeProjectsByUpdatedAt(localProjects, firebaseProjects), tombstonesRef.current);
            cloudLoadFailedRef.current = false;
            mergedProjects.forEach(project => {
              const cloudVersion = firebaseProjects.find(item => item.id === project.id);
              if (cloudVersion && (cloudVersion.updatedAt || 0) >= (project.updatedAt || 0)) {
                lastPushedRef.current.set(project.id, project.updatedAt);
              }
            });
            setProjects(mergedProjects);
            await replaceAllProjectsInDb(mergedProjects);
            mergedProjects.forEach(project => lastSavedToDbRef.current.set(project.id, project.updatedAt));
            setStorageStatus(`IndexedDB đã lưu cache ${mergedProjects.length} tác phẩm`);
            setCloudStatus(detailed.failed > 0
              ? `Firebase tải lỗi ${detailed.failed} tác phẩm — đã giữ bản local, không đồng bộ đè.`
              : mergedProjects.length > 0
                ? `Firebase đã tải ${mergedProjects.length} tác phẩm từ ${getFirebaseProjectId()}`
                : `Firebase sẵn sàng cho ${authUser?.email || 'tài khoản này'}`
            );
            return;
          } catch (firebaseError) {
            // FIX mat du lieu: truoc day loi Firebase -> setProjects([]) -> autosave xoa sach cache local.
            // Nay roi xuong du lieu local trong may va tam dung dong bo cloud toi lan tai thanh cong.
            console.warn(firebaseError);
            cloudLoadFailedRef.current = true;
            if (!cancelled) {
              setCloudStatus('Không tải được Firebase — đang dùng dữ liệu local trong máy; đồng bộ cloud tạm dừng tới lần tải thành công.');
            }
          }
        }

        const dbProjects = applyTombstones((await loadProjectsFromDb()).map(normalizeProjectRecord), tombstonesRef.current);
        if (cancelled) return;

        if (dbProjects.length > 0) {
          dbProjects.forEach(project => lastSavedToDbRef.current.set(project.id, project.updatedAt));
          setProjects(dbProjects);
          setStorageStatus(`IndexedDB đã tải ${dbProjects.length} tác phẩm`);
        } else {
          const saved = localStorage.getItem('but-nghien-v19-store');
          const legacyProjects = saved ? (JSON.parse(saved) as StoryProject[]).map(normalizeProjectRecord) : [];
          setProjects(legacyProjects);
          if (legacyProjects.length > 0) {
            await replaceAllProjectsInDb(legacyProjects);
            legacyProjects.forEach(project => lastSavedToDbRef.current.set(project.id, project.updatedAt));
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
    // IndexedDB ghi theo dirty (chi project doi updatedAt + xoa project da bien mat),
    // khong con clear+put lai toan bo thu vien sau moi thay doi nhu truoc.
    const dbDirtyProjects = projects.filter(project => lastSavedToDbRef.current.get(project.id) !== project.updatedAt);
    const dbDeletedIds = [...lastSavedToDbRef.current.keys()].filter(id => !projects.some(project => project.id === id));
    if (dbDirtyProjects.length > 0 || dbDeletedIds.length > 0) {
      Promise.all([
        ...dbDirtyProjects.map(project => saveProjectToDb(project)),
        ...dbDeletedIds.map(id => deleteProjectFromDb(id)),
      ])
        .then(() => {
          dbDirtyProjects.forEach(project => lastSavedToDbRef.current.set(project.id, project.updatedAt));
          dbDeletedIds.forEach(id => lastSavedToDbRef.current.delete(id));
          setStorageStatus(`IndexedDB đã lưu ${projects.length} tác phẩm`);
        })
        .catch(error => {
          console.error(error);
          setStorageStatus('Lưu IndexedDB lỗi');
        });
    }

    if (!isFirebaseConfigured()) {
      setCloudStatus('Firebase chưa cấu hình');
      return;
    }
    if (!authUser) {
      setCloudStatus('Cần đăng nhập Firebase để lưu dữ liệu');
      return;
    }
    if (cloudLoadFailedRef.current) {
      setCloudStatus('Đang dùng dữ liệu local; đồng bộ Firebase tạm dừng vì lần tải gần nhất lỗi.');
      return;
    }

    const dirtyProjects = projects.filter(project =>
      !((tombstonesRef.current[project.id] || 0) >= (project.updatedAt || 0) && tombstonesRef.current[project.id] > 0)
      && lastPushedRef.current.get(project.id) !== project.updatedAt
    );
    if (dirtyProjects.length === 0) {
      setCloudStatus('Firebase đã đồng bộ');
      return;
    }

    setCloudStatus('Đang lưu Firebase...');
    const timer = window.setTimeout(() => {
      saveProjectsToFirebase(dirtyProjects)
        .then(() => {
          dirtyProjects.forEach(project => lastPushedRef.current.set(project.id, project.updatedAt));
          setCloudStatus(`Firebase đã lưu ${dirtyProjects.length} tác phẩm thay đổi`);
        })
        .catch(error => {
          console.error(error);
          setCloudStatus('Lưu Firebase lỗi, dữ liệu vẫn còn trong máy');
        });
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [projects, isHydrated, authUser?.uid, syncNonce]);

  // Trinh phat nghe truyen: mot instance duy nhat, trang thai phan anh qua callback vao React state.
  useEffect(() => {
    const player = new SpeechPlayer({
      onState: (state) => {
        setTtsState(state);
        if (speechPlayerRef.current) setTtsSegmentText(speechPlayerRef.current.currentSegmentText());
        if (state === 'ended' || state === 'error' || state === 'idle') {
          const waiters = playerWaitersRef.current;
          playerWaitersRef.current = [];
          waiters.forEach(resolve => resolve());
        }
      },
      onIndex: () => {
        if (speechPlayerRef.current) {
          setTtsIndex(speechPlayerRef.current.currentIndex);
          setTtsSegmentText(speechPlayerRef.current.currentSegmentText());
        }
      },
      onEngine: (engine) => {
        setTtsEngine(engine);
        if (speechPlayerRef.current) setTtsVoices(speechPlayerRef.current.voices);
      },
    });
    player.onChapterSkip = (direction) => {
      // Nut next/prev tren man hinh khoa: next = bo qua chuong dang doc; prev = doc lai chuong nay.
      if (direction < 0 && autoReadingIndexRef.current != null) {
        autoReadDoneRef.current.delete(autoReadingIndexRef.current);
        autoReadQueueRef.current.unshift(autoReadingIndexRef.current);
      }
      speechPlayerRef.current?.stop();
    };
    speechPlayerRef.current = player;
    return () => { player.stop(); speechPlayerRef.current = null; };
  }, []);

  useEffect(() => { worldBibleRef.current = worldBible; }, [worldBible]);

  // Doi du an dang mo -> dung nghe va dong thanh phat (tranh nghe nham chuong cua du an khac).
  useEffect(() => {
    speechPlayerRef.current?.stop();
    setTtsSession(null);
  }, [activeProjectId]);

  const handleListenChapter = async (chapter: Chapter) => {
    const segments = splitSentencesForSpeech(chapter.content || '');
    if (!segments.length) {
      alert('Chương này chưa có nội dung để nghe.');
      return;
    }
    const player = speechPlayerRef.current;
    if (!player) return;
    setTtsSession({ chapterIndex: chapter.index, title: chapter.title, total: segments.length });
    setTtsState('loading');
    const ownerProject = projects.find(p => p.id === activeProjectId);
    await player.load(segments, { rate: ttsRate, mediaTitle: `${ownerProject?.title || 'Bút Nghiên'} — Chương ${chapter.index}: ${chapter.title}` });
    const voices = player.voices;
    setTtsVoices(voices);
    setTtsVoiceId(voices[0]?.id || '');
    setTtsSegmentText(player.currentSegmentText());
    await player.play();
  };

  const handleCloseTts = () => {
    speechPlayerRef.current?.stop();
    setTtsSession(null);
  };

  const waitForPlayerFinish = () => new Promise<void>((resolve) => {
    const player = speechPlayerRef.current;
    if (!player || player.currentState === 'ended' || player.currentState === 'idle' || player.currentState === 'error') {
      resolve();
      return;
    }
    playerWaitersRef.current.push(resolve);
  });

  const playChapterForSession = async (chapter: Chapter) => {
    const player = speechPlayerRef.current;
    if (!player) return;
    const segments = splitSentencesForSpeech(chapter.content || '');
    if (!segments.length) return;
    const ownerProject = projects.find(p => p.id === activeProjectId);
    await player.load(segments, { rate: ttsRate, mediaTitle: `${ownerProject?.title || 'Bút Nghiên'} — Chương ${chapter.index}: ${chapter.title}` });
    setTtsVoices(player.voices);
    setTtsVoiceId(player.voices[0]?.id || '');
    setTtsSession({ chapterIndex: chapter.index, title: chapter.title, total: segments.length });
    setTtsSegmentText(player.currentSegmentText());
    await player.play();
  };

  const runAutoReader = async () => {
    if (autoReaderActiveRef.current) return;
    autoReaderActiveRef.current = true;
    try {
      while (!autoStopRef.current) {
        const next = nextInReadQueue(autoReadQueueRef.current, autoReadDoneRef.current);
        if (next == null) {
          if (autoWriterDoneRef.current) break;
          await new Promise(resolve => setTimeout(resolve, 700));
          continue;
        }
        autoReadDoneRef.current.add(next);
        autoReadingIndexRef.current = next;
        const chapter = writtenChaptersRef.current.find(c => c.index === next);
        if (chapter?.content) {
          setAutoSession(prev => prev ? { ...prev, readingIndex: next } : prev);
          await playChapterForSession(chapter);
          await waitForPlayerFinish();
        }
        autoReadingIndexRef.current = null;
        setAutoSession(prev => prev && prev.readingIndex === next ? { ...prev, readingIndex: null } : prev);
      }
    } finally {
      autoReaderActiveRef.current = false;
    }
  };

  const stopAutoSession = () => {
    autoStopRef.current = true;
    autoWriterDoneRef.current = true;
    speechPlayerRef.current?.stop();
    setAutoSession(prev => prev ? { ...prev, running: false, phase: 'Đã dừng theo yêu cầu.', writingIndex: null } : prev);
  };

  const runAutoSession = async () => {
    if (autoRunningRef.current) return;
    if (!activeProjectId) { alert('Hãy mở một dự án trước.'); return; }
    if (params.projectType !== 'Trường Thiên') { alert('Chế độ tự động dành cho truyện Trường Thiên (nhiều chương). Truyện ngắn hãy dùng nút Khai bút trong trình soạn.'); return; }
    if (!autoWriteEnabled && !autoReadEnabled) { alert('Hãy bật ít nhất một trong hai: Tự viết tiếp hoặc Tự đọc.'); return; }
    if (autoWriteEnabled && !hasRoadmapReady) { alert('Chưa có lộ trình Arc + Thiên Cơ Lục. Hãy lập lộ trình trước khi chạy tự viết.'); return; }

    autoStopRef.current = false;
    autoRunningRef.current = true;
    autoWriterDoneRef.current = false;
    autoReadQueueRef.current = [];
    autoReadDoneRef.current = new Set();
    const baseVolumes = volumesRef.current.length ? volumesRef.current : volumes;
    const baseWritten = writtenChaptersRef.current.length ? writtenChaptersRef.current : writtenChapters;
    const writtenSet = new Set<number>(baseWritten.filter(c => c.content).map(c => c.index));
    const plan = autoWriteEnabled ? planAutoWriteChapters(baseVolumes, writtenSet, params.totalChapters, autoChapterLimit) : [];
    const readFrom = autoReadFrom > 0 ? autoReadFrom : (plan.length ? plan[0] : Math.min(...[...writtenSet], 1));
    if (autoReadEnabled) {
      sortChapters(baseWritten.filter(c => c.content && c.index >= readFrom)).forEach(c => autoReadQueueRef.current.push(c.index));
    }
    setAutoSession({ running: true, phase: 'Đang khởi động phiên tự động…', message: '', writingIndex: null, readingIndex: null, writtenThisSession: [], targetCount: plan.length });
    if (!plan.length && !autoReadQueueRef.current.length) {
      setAutoSession({ running: false, phase: 'Không còn chương nào để viết hoặc đọc theo lựa chọn hiện tại.', message: '', writingIndex: null, readingIndex: null, writtenThisSession: [], targetCount: 0 });
      autoRunningRef.current = false;
      autoWriterDoneRef.current = true;
      return;
    }
    setIsGenerating(true);
    let bibleCursor = worldBibleRef.current || worldBible;
    const writtenThisSession: number[] = [];
    try {
      const readerPromise = autoReadEnabled ? runAutoReader() : Promise.resolve();
      for (const chapterIndex of plan) {
        if (autoStopRef.current) break;
        const liveVolumes = volumesRef.current.length ? volumesRef.current : volumes;
        let currentArc = liveVolumes.find(v => chapterIndex >= (v.chapterStart || 0) && chapterIndex <= (v.chapterEnd || Number.MAX_SAFE_INTEGER))
          || getArcByChapterIndex(chapterIndex) || getActiveArc();
        if (!currentArc) throw new Error(`Không tìm thấy Arc chứa chương ${chapterIndex}.`);
        if (!hasCompleteArcChapterPlan(currentArc as Volume)) {
          setAutoSession(prev => prev ? { ...prev, phase: `Đang lập bản đồ chương cho ${currentArc.title}…` } : prev);
          currentArc = await ensureArcChapterPlans(currentArc.index);
        }
        const bibleBefore = bibleCursor;
        const beforeWritten = writtenChaptersRef.current.length ? writtenChaptersRef.current : writtenChapters;
        const planChapter = currentArc.chapters?.find(c => c.index === chapterIndex);
        const targetWords = planChapter?.targetWords || params.length;
        setAutoSession(prev => prev ? { ...prev, phase: `Đang viết chương ${chapterIndex}…`, writingIndex: chapterIndex } : prev);
        setGenerationStatus(`[Tự động] Đang chấp bút Chương ${chapterIndex}...`);
        setStory('');
        const content = await generateChapterStream(params, beforeWritten, chapterIndex, bibleBefore, '', generalSummary, currentArc, (chunk) => setStory(prev => prev + chunk), false);
        if (!content.trim()) throw new Error(`Chương ${chapterIndex}: Gemini chưa trả nội dung.`);
        const words = countWords(content);
        if (words < Math.max(650, Math.floor(targetWords * 0.95)) || isLikelyCutOffText(content)) {
          throw new Error(`Chương ${chapterIndex} chưa đạt chuẩn (${words}/${targetWords} chữ hoặc cụt cuối) — phiên tự động dừng để tránh lưu bản lỗi.`);
        }
        setStory(content);
        const saved = await persistChapterContent(content, currentArc, undefined, { chapterIndex, bible: bibleBefore });
        bibleCursor = saved.updatedBible;
        worldBibleRef.current = bibleCursor;
        if (autoReviewEnabled && !autoStopRef.current) {
          setAutoSession(prev => prev ? { ...prev, phase: `Đang thẩm định chương ${chapterIndex} (Cụm 2)…` } : prev);
          try {
            const validation = await validateChapterLogic(content, beforeWritten, bibleBefore, currentArc, generalSummary, params, chapterIndex);
            if (chapterReviewNeedsRewrite(validation, '')) {
              setAutoSession(prev => prev ? { ...prev, phase: `Cụm 3 đang viết lại chương ${chapterIndex}…` } : prev);
              let discardedReason = '';
              const rewritten = await rewriteChapterWithReviewStream(params, beforeWritten, chapterIndex, bibleBefore, '', generalSummary, currentArc, content, validation, (chunk) => setStory(prev => prev + chunk), (reason) => { discardedReason = reason; });
              const rewrittenWords = countWords(rewritten);
              if (!discardedReason && rewrittenWords >= Math.max(650, Math.floor(targetWords * 0.95)) && !isLikelyCutOffText(rewritten)) {
                const savedRewrite = await persistChapterContent(rewritten, currentArc, undefined, { chapterIndex });
                bibleCursor = savedRewrite.updatedBible;
                worldBibleRef.current = bibleCursor;
              }
            }
          } catch (reviewError) {
            console.warn('Cụm 2/3 tự động bỏ qua cho chương', chapterIndex, reviewError);
          }
        }
        writtenThisSession.push(chapterIndex);
        setAutoSession(prev => prev ? { ...prev, writtenThisSession: [...writtenThisSession] } : prev);
        if (autoReadEnabled && chapterIndex >= readFrom) autoReadQueueRef.current.push(chapterIndex);
      }
      autoWriterDoneRef.current = true;
      await readerPromise;
      if (!autoStopRef.current) {
        setAutoSession(prev => prev ? { ...prev, running: false, phase: 'Hoàn thành phiên tự động.', writingIndex: null, readingIndex: null } : prev);
      }
    } catch (error) {
      console.error(error);
      autoWriterDoneRef.current = true;
      setAutoSession(prev => prev ? { ...prev, running: false, phase: 'Phiên tự động dừng vì lỗi', message: friendlyError(error), writingIndex: null } : prev);
    } finally {
      autoRunningRef.current = false;
      setIsGenerating(false);
      setGenerationStatus('');
    }
  };

  // Co mang tro lai -> kich lai dong bo cloud ngay thay vi cho thay doi ke tiep.
  useEffect(() => {
    const onOnline = () => setSyncNonce(nonce => nonce + 1);
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // Xin quyen luu tru ben (giam nguy co Safari don IndexedDB) + do dung luong da dung.
  useEffect(() => {
    if (!isHydrated) return;
    const storage = navigator.storage;
    if (!storage) return;
    if (storage.persist) storage.persist().catch(() => undefined);
    if (storage.estimate) {
      storage.estimate().then(estimate => {
        if (typeof estimate.usage === 'number') {
          setStorageUsageText(`Đã dùng ~${(estimate.usage / 1048576).toFixed(1)} MB${estimate.quota ? ` / ${(estimate.quota / 1073741824).toFixed(1)} GB` : ''}`);
        }
      }).catch(() => undefined);
    }
  }, [isHydrated]);

  // Phim tat: Ctrl/Cmd+S luu ban nhap trong trinh viet; Ctrl/Cmd+Enter o man Lo trinh = viet chuong ke tiep.
  const editorActionsRef = useRef<{ save: () => void; writeNext: () => void }>({ save: () => undefined, writeNext: () => undefined });
  useEffect(() => {
    editorActionsRef.current = { save: handleSaveCurrentDraft, writeNext: openEditorWithGuard };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's' && view === 'editor' && !isGenerating) {
        event.preventDefault();
        editorActionsRef.current.save();
      }
      if (event.key === 'Enter' && view === 'outline' && !isGenerating) {
        event.preventDefault();
        editorActionsRef.current.writeNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view, isGenerating]);

  const toggleGenre = (genre: Genre) => {
    updateDraftParams(prev => ({
      ...prev,
      genres: prev.genres.includes(genre) ? prev.genres.filter(g => g !== genre) : [...prev.genres, genre]
    }));
  };

  const handleProjectTypeChange = (projectType: StoryParams['projectType']) => {
    updateDraftParams(prev => ({
      ...prev,
      projectType,
      totalChapters: projectType === 'Truyện Ngắn' ? 1 : Math.max(2, prev.totalChapters || 5),
    }));
  };

  const normalizeParams = (draft: StoryParams): StoryParams => {
    const requestedTotalChapters = clamp(Math.round(Number(draft.totalChapters) || 1), MIN_TOTAL_CHAPTERS, MAX_TOTAL_CHAPTERS);
    const effectiveProjectType = draft.projectType === 'Truyện Ngắn' && requestedTotalChapters > 1 ? 'Trường Thiên' : draft.projectType;

    return {
      ...draft,
      projectType: effectiveProjectType,
      totalChapters: effectiveProjectType === 'Truyện Ngắn' ? 1 : requestedTotalChapters,
      length: clamp(Math.round(Number(draft.length) || 2000), MIN_CHAPTER_WORDS, MAX_CHAPTER_WORDS),
      genres: draft.genres.length > 0 ? draft.genres : ['Kỳ ảo'],
      seed: draft.seed?.trim() || '',
      referenceStories: draft.referenceStories?.trim() || '',
      directionLock: draft.directionLock?.trim() || '',
      character: {
        ...draft.character,
        name: (draft.character.name || '').trim(),
        personality: draft.character.personality?.trim(),
        goal: draft.character.goal?.trim()
      }
    };
  };

  const validateSetupParams = (draft: StoryParams) => {
    if (getConfiguredGeminiKeyCount() === 0) return 'Chưa có Gemini key khả dụng. Hãy kiểm tra các biến GEMINI_API_KEY_* trên Vercel rồi redeploy hoặc khởi động lại server.';
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
    if (/CONTENT_BLOCKED|Gemini chặn prompt|từ chối tạo nội dung/i.test(message)) {
      return 'Gemini đã từ chối tạo nội dung này vì bộ lọc an toàn của Google — đây không phải lỗi key. Hãy thử: giảm slider Bạo lực/Tình cảm, diễn đạt lại ý tưởng hoặc đoạn nhạy cảm theo hướng hàm ý hơn, rồi chạy lại. Trần nội dung do Gemini quyết định, app không nới được.';
    }
    if (/Key 6 chọn hướng|Key 6 chon huong|direction/i.test(message)) {
      return 'Chưa tạo được các hướng truyện: Gemini đang từ chối kho key dùng chung. Hãy kiểm tra các biến GEMINI_API_KEY_* trên Vercel đã bật Generative Language API, không bị giới hạn referrer/IP với Vercel Serverless, rồi redeploy.';
    }
    if (/GEMINI_API_KEY_5|GEMINI_API_KEY_6|Cụm 3|Cum 3|rewriter/i.test(message)) {
      return 'Cụm 3 chưa dùng được: Gemini đang từ chối quyền truy cập của kho key dùng chung. Hãy kiểm tra các biến GEMINI_API_KEY_* trên Vercel thuộc project đã bật Generative Language API, bỏ giới hạn referrer/IP không phù hợp với Vercel Serverless, rồi redeploy.';
    }
    if (/GEMINI_API_KEY_3|GEMINI_API_KEY_4|Cụm 2|Cum 2|reviewer/i.test(message)) {
      return 'Cụm 2 chưa dùng được: hãy kiểm tra kho key dùng chung (GEMINI_API_KEY_* trên Vercel) đã bật Generative Language API và được phép gọi từ Vercel Serverless.';
    }
    if (/GEMINI_API_KEY_1|GEMINI_API_KEY_2|Cụm 1|Cum 1|writer/i.test(message)) {
      return 'Cụm 1 chưa dùng được: hãy kiểm tra kho key dùng chung (GEMINI_API_KEY_* trên Vercel) đã bật Generative Language API và được phép gọi từ Vercel Serverless.';
    }
    if (
      message.includes('GEMINI_API_KEY_') ||
      message.includes('Gemini API key')
    ) return message;
    if (message.includes('429')) return 'Gemini đang bị giới hạn quota/rate limit. Hãy chờ một lúc, giảm số chữ/chương, hoặc dùng key khác.';
    if (message.includes('503') || message.toLowerCase().includes('high demand')) return 'Gemini đang quá tải. Hệ thống đã thử model dự phòng nhưng vẫn chưa có lượt trống; hãy chờ vài phút rồi thử lại.';
    if (message.includes('400')) return 'Gemini từ chối request. Kiểm tra lại tên model, GEMINI_MAX_OUTPUT_TOKENS hoặc giảm độ dài chương.';
    if (message.includes('403') || message.includes('401')) return 'Gemini API key không hợp lệ hoặc chưa được cấp quyền dùng API.';
    if (message.includes('JSON')) return 'AI trả về dữ liệu chưa đúng định dạng. Hãy thử lại; app hiện chỉ yêu cầu Arc ở bước đầu và sẽ sinh bản đồ chương theo từng Arc khi viết.';
    if (message.includes('Failed to fetch')) return 'Không kết nối được Gemini API. Kiểm tra mạng hoặc CORS/trình duyệt.';
    return message || 'Có lỗi không xác định.';
  };

  const isGeminiKeyInfrastructureError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error || '');
    return /401|403|API key|GEMINI_API_KEY_|không hợp lệ|chưa được cấp quyền/i.test(message);
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

  const lockDirectionIntoParams = (draft: StoryParams, choice: StoryDirectionChoice) => normalizeParams({
    ...draft,
    directionLock: choice.lock,
  });

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
    setDirectionChoices([]);
    setPendingDirectionParams(null);
    setSelectedDirectionId('');
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
    const unsyncedCount = projects.filter(project => (lastPushedRef.current.get(project.id) || 0) !== (project.updatedAt || 0)).length;
    if (cloudLoadFailedRef.current || unsyncedCount > 0) {
      const proceed = window.confirm(`Còn ${unsyncedCount} tác phẩm chưa đồng bộ lên Firebase${cloudLoadFailedRef.current ? ' (và lần tải cloud gần nhất bị lỗi)' : ''}. Đăng xuất sẽ XÓA bản lưu trong máy này — phần chưa đồng bộ sẽ mất hẳn. Hãy xuất JSON sao lưu trước khi đăng xuất. Vẫn đăng xuất?`);
      if (!proceed) return;
    }
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

  const validateShortStoryDraft = async (body: string, title: string, workingParams: StoryParams) => {
    const shortStoryCanon = [
      '# ĐIỂM NHÌN VÀ TÊN GỌI',
      `- Tên hồ sơ "${workingParams.character.name || 'chưa đặt'}" chỉ được dùng sau khi truyện có logic đặt tên hoặc gọi tên.`,
      '- Nhân vật chỉ được biết, nói và hành động theo tuổi, hoàn cảnh, ký ức và thông tin đã xuất hiện trong truyện.',
      '# MÂU THUẪN ĐANG MỞ',
      `- Ý tưởng khởi nguồn: ${workingParams.seed || 'Truyện ngắn độc lập.'}`,
      '# ĐIỀU CẤM PHÁ LOGIC',
      '- Không nhảy cóc qua nhận nuôi, đặt tên, trưởng thành, đổi thân phận hoặc biết bí mật nếu chưa có cảnh nối nguyên nhân - chuyển biến.',
    ].join('\n');
    const shortStoryArc: Volume = {
      index: 1,
      title: 'Truyện ngắn',
      summary: workingParams.seed || 'Một truyện ngắn độc lập, có mở truyện, phát triển, cao trào và dư âm.',
      purpose: 'Thẩm định logic một truyện độc lập trước khi lưu.',
      chapterStart: 1,
      chapterEnd: 1,
      chapters: [{
        index: 1,
        title,
        summary: workingParams.seed || title,
        objective: 'Hoàn chỉnh xung đột chính và dư âm mà không phá logic nhân vật.',
        targetWords: workingParams.length,
        beats: ['mở tình thế', 'đẩy lựa chọn', 'trả hậu quả'],
        mustInclude: ['đúng tên gọi theo thời điểm', 'không nhảy cóc nhận thức'],
      }],
    };
    const validation = await validateChapterLogic(body, [], shortStoryCanon, shortStoryArc, workingParams.seed || title, workingParams, 1);
    if (!validation.isValid) {
      // Khong huy truyen da viet xong chi vi mot nhan dinh cua Cum 2: giu truyen, hien bao cao de tac gia quyet dinh.
      setDraftReview(validation);
      setGenerationStatus(validation.unverified
        ? 'Truyện ngắn đã viết xong nhưng CHƯA thẩm định được — hãy thẩm định lại trước khi coi là bản chính thức.'
        : `Truyện ngắn đã viết xong; Cụm 2 còn góp ý: ${validation.reason || 'xem báo cáo thẩm định.'} Truyện vẫn được giữ lại.`);
    }
    return validation;
  };

  const renderStoryParagraphs = (text: string) => {
    const blocks = text
      .replace(/\r\n/g, '\n')
      .split(/\n{2,}/)
      .map(block => block.trim())
      .filter(Boolean);

    return blocks.map((block, blockIndex) => {
      const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
      const isShortBeat = lines.length === 1 && lines[0].length <= 120 && /[.!?…)"'\]]$/.test(lines[0]);
      const isDialogue = lines.length === 1 && /^(?:[-–—"“']|\w.+:)/.test(lines[0]);

      if (lines.length > 1) {
        return (
          <div key={`block-${blockIndex}`} className="manuscript-paragraph space-y-3">
            {lines.map((line, lineIndex) => (
              <p key={`line-${blockIndex}-${lineIndex}`} className="manuscript-line">
                {line}
              </p>
            ))}
          </div>
        );
      }

      return (
        <p
          key={`block-${blockIndex}`}
          className={`manuscript-paragraph ${isShortBeat ? 'manuscript-beat' : ''} ${isDialogue ? 'manuscript-dialogue' : ''}`}
        >
          {block}
        </p>
      );
    });
  };

  const renderOutlineText = (text: string) => {
    let source = text.replace(/\r\n/g, '\n').trim();
    if (source && !/^\s*#{1,3}\s+/m.test(source) && source.length > 220) {
      const sentences = source
        .replace(/\s+/g, ' ')
        .match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g)
        ?.map(sentence => sentence.trim())
        .filter(Boolean) || [];
      if (sentences.length >= 4) {
        const first = sentences.slice(0, 2).join(' ');
        const second = sentences.slice(2, Math.max(4, Math.ceil(sentences.length * 0.45))).join(' ');
        const third = sentences.slice(Math.max(4, Math.ceil(sentences.length * 0.45)), Math.max(6, Math.ceil(sentences.length * 0.75))).join(' ');
        const last = sentences.slice(Math.max(6, Math.ceil(sentences.length * 0.75))).join(' ');
        source = [
          '# Lời hứa truyện',
          first,
          '',
          '# Trục diễn tiến',
          second,
          '',
          '# Cao trào và phản lực',
          third,
          '',
          '# Kết cục dự kiến',
          last,
        ].join('\n');
      }
    }

    if (source && !/^\s*#{1,3}\s*Sơ lược truyện/im.test(source)) {
      const synopsis = params.seed?.trim()
        || `${params.character.name || 'Nhân vật chính'} theo đuổi mục tiêu "${params.character.goal || 'đã khóa'}" qua lộ trình ${params.totalChapters} chương, mỗi Arc phải đẩy một tầng diễn tiến mới.`;
      source = ['# Sơ lược truyện', synopsis, '', source].join('\n');
    }

    const blocks = source
      .replace(/\r\n/g, '\n')
      .split(/\n{2,}/)
      .map(block => block.trim())
      .filter(Boolean);

    if (!blocks.length) return null;

    return blocks.map((block, index) => {
      const headingMatch = block.match(/^#{1,3}\s+(.+)$/m);
      if (headingMatch && block.trim().startsWith('#')) {
        const [, heading] = headingMatch;
        const body = block.replace(/^#{1,3}\s+.+\n?/, '').trim();
        return (
          <div key={`outline-${index}`} className="space-y-2">
            <h4 className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-700">{heading}</h4>
            {body && <p className="story-font text-base text-stone-700 leading-relaxed whitespace-pre-wrap">{body}</p>}
          </div>
        );
      }

      return (
        <p key={`outline-${index}`} className="story-font text-base text-stone-700 leading-relaxed whitespace-pre-wrap">
          {block}
        </p>
      );
    });
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
      '# ĐIỂM NHÌN VÀ TÊN GỌI',
      `- Ngôi kể đã khóa: ${draft.narrativeView || 'Ngôi thứ ba hạn chế bám nhân vật chính'}.`,
      `- Tên hồ sơ "${draft.character.name || 'chưa đặt'}" chỉ được dùng trong văn xuôi sau khi có cảnh đặt/gọi/nhận biết tên; trước mốc đó dùng cách gọi theo quan hệ/hoàn cảnh.`,
      '- Nhân vật chỉ được biết, nói và hành động theo tuổi, ký ức và thông tin đã xuất hiện trong truyện.',
      '',
      '# ĐỊA DANH/VẬT PHẨM/HỆ THỐNG',
      rawWorldBuilding?.trim() || 'Thế giới sẽ được giữ nhất quán theo thể loại, luật diễn tiến và các giới hạn đã đặt.',
      '',
      '# LỘ TRÌNH ARC',
      arcLines || 'Arc chưa có dữ liệu.',
      '',
      '# HƯỚNG TRUYỆN ĐÃ KHÓA',
      draft.directionLock || 'Chưa khóa hướng riêng; đi theo Đại cục và hồ sơ đầu vào.',
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
    if (volume.degraded) return false;
    const range = getVolumeRange(volume);
    if (!range) return false;
    const chaptersByIndex = new Map((volume.chapters || []).map(chapter => [chapter.index, chapter]));
    for (let index = range.start; index <= range.end; index++) {
      const chapter = chaptersByIndex.get(index);
      if (!chapter?.objective || chapter.planFallback || !(chapter.beats || []).length) return false;
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
  const fallbackPlanCount = plannedChapters.filter(chapter => chapter.planFallback).length;
  const plannedChapterIndexes = new Set<number>();
  volumes.forEach(volume => {
    // Do phu lo trinh bang ban do chuong THAT (co objective), khong con lap day theo khoang Arc.
    (volume.chapters || []).forEach(chapter => {
      if (chapter.objective && !chapter.planFallback) plannedChapterIndexes.add(chapter.index);
    });
  });
  const writtenChapterIndexes = new Set(writtenChapters.map(chapter => chapter.index));
  const pendingBibleChapters = sortChapters(writtenChapters.filter(chapter => chapter.biblePending));
  const foldedManuscriptQuery = foldText(manuscriptQuery.trim());
  const manuscriptMatchByIndex = new Map<number, number>();
  if (foldedManuscriptQuery) {
    writtenChapters.forEach(chapter => {
      const haystack = foldText(`${chapter.title}\n${chapter.content || ''}`);
      const count = haystack.split(foldedManuscriptQuery).length - 1;
      if (count > 0) manuscriptMatchByIndex.set(chapter.index, count);
    });
  }
  const visibleManuscriptChapters = foldedManuscriptQuery
    ? sortChapters(writtenChapters).filter(chapter => manuscriptMatchByIndex.has(chapter.index))
    : sortChapters(writtenChapters);
  const manuscriptTotalWords = writtenChapters.reduce((sum, chapter) => sum + countWords(chapter.content || ''), 0);
  const weekCutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const manuscriptWeekWords = writtenChapters
    .filter(chapter => (chapter.writtenAt || 0) >= weekCutoff)
    .reduce((sum, chapter) => sum + countWords(chapter.content || ''), 0);
  const projectQuickStats = (project: StoryProject) => {
    const chapters = (project.volumes || []).flatMap(volume => volume.chapters || []).filter(chapter => chapter.content);
    return {
      chapterCount: chapters.length,
      totalWords: chapters.reduce((sum, chapter) => sum + countWords(chapter.content || ''), 0),
    };
  };
  const missingChapterIndexes = params.projectType === 'Trường Thiên'
    ? Array.from({ length: Math.max(0, params.totalChapters) }, (_, index) => index + 1).filter(index => !plannedChapterIndexes.has(index))
    : [];
  // FIX deadlock (phat hien qua test live 2026-11-04): ban do chuong chi tiet chi duoc sinh LAZY
  // theo tung Arc boi ensureArcChapterPlans, ma ham do chi chay BEN TRONG luong chuan bi viet —
  // trong khi moi nut viet deu bi chan boi hasRoadmapReady neu chua co san ban do cho MOI chuong.
  // Ket qua: du an Truong Thien moi khong bao gio viet duoc chuong 1. Cong viet chi doi hoi dung
  // tien de that (co Arc + Dai cuc + Thien Co Luc); do phu ban do chi tiet (missingChapterIndexes)
  // chi con dung de hien thi tien do, khong chan viet nua.
  const writeGateIssues = params.projectType === 'Trường Thiên'
    ? [
        volumes.length === 0 ? 'Chưa có Arc.' : '',
        !generalSummary.trim() ? 'Chưa có Đại cục.' : '',
        !worldBible.trim() ? 'Chưa có Thiên Cơ Lục.' : '',
      ].filter(Boolean)
    : [];
  const roadmapIssues = writeGateIssues;
  const hasRoadmapReady = params.projectType !== 'Trường Thiên' || writeGateIssues.length === 0;
  const firstUnwrittenChapterIndex = params.projectType === 'Trường Thiên'
    ? Array.from({ length: Math.max(0, params.totalChapters) }, (_, index) => index + 1).find(index => plannedChapterIndexes.has(index) && !writtenChapterIndexes.has(index))
    : undefined;
  const firstUnwrittenPlan = firstUnwrittenChapterIndex
    ? plannedChapters.find(chapter => chapter.index === firstUnwrittenChapterIndex)
    : plannedChapters.find(chapter => !writtenChapterIndexes.has(chapter.index));
  const currentChapterPlan = getChapterPlan(currentChapterIndex);
  const currentDraftIsPending = Boolean(
    story.trim()
    && pendingDraftMeta
    && pendingDraftMeta.chapterIndex === currentChapterIndex
    && pendingDraftMeta.arcIndex === activeArcIndex,
  );
  const currentDraftIsAutosaved = Boolean(
    currentDraftIsPending
    && draftAutosavedMeta
    && draftAutosavedMeta.chapterIndex === currentChapterIndex
    && draftAutosavedMeta.arcIndex === activeArcIndex,
  );
  const draftReviewIssues = draftReview ? [
    ...(draftReview.setupIssues || []),
    ...(draftReview.structureIssues || []),
    ...(draftReview.logicIssues || []),
    ...(draftReview.canonIssues || []),
    ...(draftReview.povIssues || []),
    ...(draftReview.metricIssues || []),
    ...(draftReview.ramblingIssues || []),
    ...(draftReview.styleIssues || []),
    ...(draftReview.repetitionIssues || []),
    ...(draftReview.dictionIssues || []),
    ...(draftReview.suggestions || []),
    ...(draftReview.rewriteDirectives || []),
  ] : [];
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
    { label: 'Hướng truyện', status: params.directionLock ? 'done' : view === 'directions' ? 'active' : 'locked' },
    { label: 'Lộ trình', status: hasRoadmapReady ? 'done' : activeProjectId ? 'active' : 'locked' },
    { label: 'Chấp bút', status: writtenChapters.length > 0 ? 'done' : hasRoadmapReady ? 'active' : 'locked' },
    { label: 'Biên tập', status: logicReport ? 'done' : writtenChapters.length > 0 ? 'active' : 'locked' },
  ];
  const visibleDirectionChoices = directionChoices;
  const selectedDirection = visibleDirectionChoices.find(choice => choice.id === selectedDirectionId) || visibleDirectionChoices[0];
  const isStoryProject = (value: unknown): value is StoryProject => {
    const project = value as Partial<StoryProject>;
    if (!project?.id || !project?.params || typeof project.params !== 'object' || !Array.isArray(project?.volumes)) return false;
    return project.volumes.every(volume => Boolean(
      volume && typeof volume === 'object'
      && (volume.chapters === undefined || (Array.isArray(volume.chapters) && volume.chapters.every(chapter => Boolean(chapter && typeof chapter === 'object' && typeof chapter.index === 'number'))))
    ));
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

  const stripChapterTitlePrefix = (value: string) =>
    String(value || '').replace(/^\s*(?:c(?:hương)?\.?|chapter)\s*\d+\s*[:.：\-–—]?\s*/i, '').trim();

  const directionTitleFromLock = (lock: string) =>
    stripDirectionLabels(String(lock || '')
      .split(/\r?\n/)
      .find(line => line
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .startsWith('huong truyen da chon')) || '');

  const planFingerprint = (value: string) => stripDirectionLabels(stripChapterTitlePrefix(value))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:chuong|chapter|c)\s*\d+\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const sentenceCount = (value: string) =>
    String(value || '').split(/[.!?…。！？]+/).map(item => item.trim()).filter(Boolean).length;

  const ARC_ADMIN_TEXT_PATTERN = /(?:huong truyen da chon|logic cot truyen|nhip arc|bat buoc khi lap lo trinh|truyen chi su dung|khong su dung tuyen|tai lieu thiet lap|world building|ten tac pham|dung tai lieu nay lam quy chuan|content bat buoc|arc cau noi ngan|arc nhip vua|arc trong tam dai|phuc vu huong|dung \d+ chuong de)/;
  const ARC_STOP_WORDS = new Set([
    'arc', 'chuong', 'truyen', 'nhan', 'vat', 'chinh', 'muc', 'tieu', 'noi', 'dung', 'the', 'gioi',
    'phai', 'duoc', 'khong', 'trong', 'ngoai', 'mot', 'nhung', 'cac', 'voi', 'cua', 'cho', 'vao', 'chi',
    'huong', 'tinh', 'the', 'bien', 'co', 'lua', 'chon', 'ket', 'qua', 'moc', 'noi', 'dau', 'cuoi',
    'thiet', 'lap', 'tai', 'lieu', 'world', 'building', 'dung', 'quy', 'chuan', 'logic',
  ]);

  const meaningfulArcTokens = (value: string, limit = 28) => {
    const seen = new Set<string>();
    return planFingerprint(value)
      .split(/\s+/)
      .filter(Boolean)
      .filter(token => {
        if (token.length < 3 || ARC_STOP_WORDS.has(token) || seen.has(token)) return false;
        seen.add(token);
        return true;
      })
      .slice(0, limit);
  };

  const currentStorySignal = () =>
    `${params.seed || ''} ${params.directionLock || ''} ${params.character.name || ''} ${params.character.personality || ''} ${params.character.goal || ''} ${(params.genres || []).join(' ')}`;

  const storyKeywordSet = (extra = '') =>
    new Set(meaningfulArcTokens(`${currentStorySignal()} ${extra}`, 90));

  const sharesCurrentStorySignal = (value: string, extra = '') => {
    const keywords = storyKeywordSet(extra);
    return meaningfulArcTokens(value, 36).some(token => keywords.has(token));
  };

  const isOffProjectArcText = (value: string) => {
    const normalized = planFingerprint(value);
    if (!normalized) return false;
    if (ARC_ADMIN_TEXT_PATTERN.test(normalized)) return true;
    const tokens = meaningfulArcTokens(value, 24);
    return tokens.length >= 5 && !sharesCurrentStorySignal(value);
  };

  const isOffProjectArcTitle = (title: string, arcText = '') => {
    const normalized = planFingerprint(title);
    if (!normalized) return true;
    if (ARC_ADMIN_TEXT_PATTERN.test(normalized)) return true;
    const titleTokens = meaningfulArcTokens(title, 8);
    if (titleTokens.length === 0) return true;
    const keywords = storyKeywordSet(arcText);
    const specificTokens = titleTokens.filter(token => !['dau', 'tien', 'luat', 'choi', 'vet', 'nut', 'canh', 'cua', 'ket', 'cuc', 'gia', 'dang', 'cao'].includes(token));
    return specificTokens.length > 0 && !specificTokens.some(token => keywords.has(token));
  };

  const cleanTitleText = (value: string, limit = 4) =>
    stripDirectionLabels(value || '')
      .replace(/[#*_`"'“”‘’]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, limit)
      .join(' ');

  const storyTitleFragment = (offset = 0) => {
    const candidates = [
      params.character.name,
      directionTitleFromLock(params.directionLock || ''),
      params.character.goal,
      (params.genres || [])[offset % Math.max(1, (params.genres || []).length)],
      params.seed,
    ]
      .map(item => cleanTitleText(item || '', 4))
      .filter(Boolean)
      .filter(item => !ARC_ADMIN_TEXT_PATTERN.test(planFingerprint(item)));
    if (candidates.length === 0) return '';
    return candidates[offset % candidates.length];
  };

  const isWeakPlanPhrase = (value: string) => {
    const normalized = planFingerprint(value);
    if (!normalized || normalized.split(/\s+/).length < 3) return true;
    return /^(dung mot canh|mot canh quyet dinh|day nhan vat|khai cuc|gioi thieu|tom tat|muc tieu|chuong thuoc|thuoc giai doan|nhan vat chinh|khong co|bien co mo mach|lua chon co gia|manh moi doi huong|hau qua quay lai|cai gia cuoi arc)/.test(normalized);
  };

  const isWeakArcSummaryText = (value: string) => {
    if (/(HƯỚNG TRUYỆN ĐÃ CHỌN|HUONG TRUYEN DA CHON|Logic cốt truyện|Logic cot truyen|Nhịp Arc|Nhip Arc|Truyện chỉ sử dụng|Truyen chi su dung|Bắt buộc khi lập lộ trình|Bat buoc khi lap lo trinh)/i.test(value)) return true;
    const normalized = planFingerprint(value);
    const wordTotal = normalized ? normalized.split(/\s+/).length : 0;
    if (!normalized || wordTotal < 45 || sentenceCount(value) < 5) return true;
    if (ARC_ADMIN_TEXT_PATTERN.test(normalized) || isOffProjectArcText(value)) return true;
    return /(?:huong truyen da chon|arc cau noi ngan|arc nhip vua|arc trong tam dai|truyen chi su dung|khong su dung tuyen|xuat phat tu mau thuan|buoc nhan vat doi trang thai|de lai moc noi|phuc vu huong|dung \d+ chuong de|phan giua arc can|cuoi arc phai|trong .+ buoc qua chuong|arc nay khai cuc|arc nay hoi nhap|arc nay phuc vu)|^(arc \d+ phu trach|arc \d+ tiep tuc|tom tat arc|khong co|khai cuc ngan|hoi nhap va khoa quy tac|day nhan vat)/.test(normalized);
  };

  const isWeakArcTitleText = (value: string) => {
    if (/(HƯỚNG TRUYỆN ĐÃ CHỌN|HUONG TRUYEN DA CHON|Tiền đề|Tien de|Logic cốt truyện|Logic cot truyen|Nhịp Arc|Nhip Arc)/i.test(value)) return true;
    const normalized = planFingerprint(value);
    if (!normalized) return true;
    if (normalized.split(/\s+/).length > 9) return true;
    return /(?:huong truyen da chon|tien de|logic cot truyen)|^(arc|arc \d+|khai cuc|phat trien|cao trao|ket cuc|hoi nhap|chuyen tiep|mo dau)$/.test(normalized);
  };

  const fallbackArcDisplayTitle = (volume: Volume) => {
    const signal = planFingerprint(currentStorySignal());
    const fragment = storyTitleFragment(volume.index - 1);
    const phases = /hack|robot|mang|internet|cyber|khoa hoc|cong nghe|du lieu/.test(signal)
      ? ['Mã Lệnh Đầu Tiên', 'Linh Hồn Trong Máy', 'Cổng Dữ Liệu Sai Lệch', 'Bản Vá Của Thực Tại', 'Cánh Cửa Ngoài Hệ Thống']
      : /ky ao|fantasy|ma phap|than thoai|di nang|phep|phu thuy/.test(signal)
        ? ['Dấu Ấn Đầu Tiên', 'Luật Của Vùng Đất Lạ', 'Bí Mật Sau Lời Nguyền', 'Cái Giá Của Phép Màu', 'Cánh Cửa Cuối Hành Trình']
        : /dieu tra|huyen nghi|bi an|manh moi|than phan|lat mat/.test(signal)
          ? ['Dấu Hỏi Đầu Tiên', 'Lớp Vỏ Giả', 'Người Giấu Chứng Cứ', 'Sự Thật Đổi Mặt', 'Đáp Án Có Giá']
          : ['Vết Nứt Đầu Tiên', 'Luật Chơi Mới', 'Dấu Vết Đổi Hướng', 'Cái Giá Dâng Cao', 'Cánh Cửa Kết Cục'];
    const phase = volume.index === volumes.length ? phases[phases.length - 1] : phases[(volume.index - 1) % Math.max(1, phases.length - 1)];
    if (!fragment) return phase;
    return volume.index === 1 ? `${phase}: ${fragment}` : `${phase} - ${fragment}`;
  };

  const getArcDisplayTitle = (volume: Volume) => {
    const originalTitle = volume.title || '';
    const rawTitle = stripDirectionLabels(volume.title || '');
    const arcContext = `${volume.content || ''} ${volume.summary || ''} ${volume.theme || ''} ${volume.objective || ''}`;
    if (!isWeakArcTitleText(originalTitle) && !isWeakArcTitleText(rawTitle) && !isOffProjectArcTitle(rawTitle, arcContext)) return rawTitle;
    return fallbackArcDisplayTitle(volume);
  };

  const getArcSynopsisState = (volume: Volume) => {
    const candidates = [volume.content, volume.summary]
      .map(item => ({ original: item || '', clean: stripDirectionLabels(item || '') }))
      .filter(item => item.clean);
    const strongCandidate = candidates.find(item => !isWeakArcSummaryText(item.original) && !isWeakArcSummaryText(item.clean) && !isOffProjectArcText(item.clean));
    if (strongCandidate) return { text: strongCandidate.clean, isFallback: false };

    const seed = stripDirectionLabels(params.seed || '') || directionTitleFromLock(params.directionLock || '');
    const premise = seed ? `mâu thuẫn "${seed.slice(0, 120)}"` : `mục tiêu "${params.character.goal || 'đã khóa'}"`;
    const name = params.character.name || 'nhân vật chính';
    const arcTitle = getArcDisplayTitle(volume);
    const theme = stripDirectionLabels(volume.theme || '') || `mâu thuẫn quanh ${params.character.goal || 'mục tiêu trung tâm'}`;
    const objective = stripDirectionLabels(volume.objective || '') || `buộc ${name} thay đổi lựa chọn trước khi sang Arc sau`;
    return {
      text: `${arcTitle} mở trong chương ${volume.chapterStart || '?'}-${volume.chapterEnd || '?'}, khi ${name} bước vào một tầng mới của ${premise}. Những chương đầu đặt rõ tình thế, người cản đường và điều ${name} chưa thể biết, để mâu thuẫn không chỉ là giới thiệu mà có sức ép thực tế. Phần giữa Arc phải đẩy nhân vật qua vài biến cố có liên kết hợp lý, mỗi biến cố làm thay đổi thông tin, quan hệ, quyền lực hoặc rủi ro đã khóa trong Thiên Cơ Lục. Trục cảm xúc của Arc là ${theme}, còn mục tiêu sơ bộ là ${objective}. Đến cuối Arc, lựa chọn của ${name} phải để lại một chuyển biến nhìn thấy được và một bí mật hoặc móc nối đủ rõ để sang Arc tiếp theo.`,
      isFallback: true,
    };
  };

  const getArcSynopsis = (volume: Volume) => getArcSynopsisState(volume).text;

  const getArcTheme = (volume: Volume) =>
    volume.theme || (volume.index === 1
      ? `Khởi điểm của ${params.character.goal || 'mục tiêu trung tâm'} và biến cố đầu tiên làm truyện chuyển động.`
      : `Một tầng thử thách mới buộc nhân vật đổi cách hiểu về ${params.character.goal || 'mục tiêu trung tâm'}.`);

  const getArcObjective = (volume: Volume) =>
    volume.objective || volume.purpose || `Đưa ${params.character.name || 'nhân vật chính'} qua một biến chuyển rõ trong chương ${volume.chapterStart || '?'}-${volume.chapterEnd || '?'}.`;

  const getCleanArcForPrompt = (volume: Volume): Volume => {
    const synopsis = getArcSynopsis(volume);
    return {
      ...volume,
      title: getArcDisplayTitle(volume),
      summary: synopsis,
      content: synopsis,
      theme: stripDirectionLabels(volume.theme || getArcTheme(volume)),
      objective: stripDirectionLabels(volume.objective || getArcObjective(volume)),
      purpose: stripDirectionLabels(volume.purpose || ''),
    };
  };

  const titleFromPlanPhrase = (value: string) => {
    const cleaned = stripDirectionLabels(stripChapterTitlePrefix(value))
      .replace(/^(?:Mục tiêu|Beat|Cảnh|Hậu quả|Móc nối|Chi tiết bắt buộc|Chủ đề Arc|Mục tiêu sơ bộ|Vai trò Arc|Nội dung Arc)\s*[:：-]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.length < 3) return '';
    const title = words.join(' ').replace(/[,.!?;:…]+$/g, '');
    return title.charAt(0).toUpperCase() + title.slice(1);
  };

  const repairVolumeChapterPlans = (volume: Volume): Volume => {
    const chapters = sortChapters(volume.chapters || []);
    const seenTitles = new Set<string>();
    const seenSummaries = new Set<string>();
    const volumeFingerprint = planFingerprint(volume.title || '');
    const start = volume.chapterStart || chapters[0]?.index || 1;
    const end = volume.chapterEnd || chapters[chapters.length - 1]?.index || start;

    const repaired = chapters.map(chapter => {
      let title = stripChapterTitlePrefix(chapter.title || '');
      let titleKey = planFingerprint(title);
      if (!title || !titleKey || titleKey === volumeFingerprint || seenTitles.has(titleKey) || isWeakPlanPhrase(title)) {
        const candidates = [
          chapter.cliffhanger,
          ...(chapter.mustInclude || []),
          ...(chapter.beats || []),
          chapter.objective,
          chapter.summary,
        ];
        title = candidates.map(item => titleFromPlanPhrase(item || '')).find(item => item && !seenTitles.has(planFingerprint(item)) && !isWeakPlanPhrase(item)) || '';
        if (!title) {
          const ratio = (chapter.index - start) / Math.max(1, end - start);
          title = chapter.index === start
            ? `Biến cố mở mạch ${chapter.index}`
            : chapter.index === end
              ? `Biến chuyển cuối Arc ${chapter.index}`
              : ratio < 0.34
                ? `Manh mối đổi hướng ${chapter.index}`
                : ratio < 0.67
                  ? `Lựa chọn đổi hướng ${chapter.index}`
                  : `Móc nối quay lại ${chapter.index}`;
        }
        titleKey = planFingerprint(title);
      }
      seenTitles.add(titleKey);

      let summary = String(chapter.summary || '').replace(/\s+/g, ' ').trim();
      let summaryKey = planFingerprint(summary);
      if (!summary || !summaryKey || seenSummaries.has(summaryKey) || isWeakPlanPhrase(summary)) {
        const firstBeat = (chapter.beats || []).find(beat => !isWeakPlanPhrase(beat || ''));
        const consequence = !isWeakPlanPhrase(chapter.cliffhanger || '') ? chapter.cliffhanger : '';
        summary = [firstBeat || chapter.objective || chapter.summary, consequence ? `Móc nối: ${consequence}` : ''].filter(Boolean).join(' ').trim();
        summaryKey = planFingerprint(summary);
      }
      seenSummaries.add(summaryKey);

      return { ...chapter, title, summary };
    });

    return { ...volume, chapters: repaired };
  };

  const handleExportManuscript = (project: StoryProject, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const safeTitle = project.title.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_') || 'ButNghien';
    downloadTextFile(`BanThao_${safeTitle}.txt`, buildManuscriptText(project));
  };

  const downloadBlobFile = (filename: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const safeProjectFileName = (project: StoryProject) =>
    project.title.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_') || 'ButNghien';

  const buildManuscriptMarkdown = (project: StoryProject, includeBible: boolean) => {
    const chapters = sortChapters((project.volumes || []).flatMap(volume => volume.chapters || []).filter(chapter => chapter.content));
    const parts = [
      `# ${project.title}`,
      '',
      `> Thể loại: ${project.params.genres.join(', ')} · Tông giọng: ${project.params.tone} · ${chapters.length} chương đã viết`,
      '',
      '## Đại cục',
      '',
      project.generalSummary || '',
      '',
    ];
    if (includeBible && project.progressionSummary) {
      parts.push('## Thiên Cơ Lục', '', project.progressionSummary, '');
    }
    chapters.forEach(chapter => {
      parts.push(`## Chương ${chapter.index}: ${chapter.title}`, '', chapter.content || '', '');
    });
    return parts.join('\n').trim();
  };

  const handleExportMarkdown = (project: StoryProject, includeBible: boolean) => {
    downloadTextFile(`BanThao_${safeProjectFileName(project)}.md`, buildManuscriptMarkdown(project, includeBible), 'text/markdown;charset=utf-8');
  };

  const handleExportDocx = async (project: StoryProject, includeBible: boolean) => {
    // docx kha nang (~200KB): tai luoi dung import dong, chi nap khi nguoi dung that su xuat DOCX.
    const { Document, Packer, Paragraph, HeadingLevel } = await import('docx');
    const chapters = sortChapters((project.volumes || []).flatMap(volume => volume.chapters || []).filter(chapter => chapter.content));
    const paragraphs: InstanceType<typeof Paragraph>[] = [
      new Paragraph({ text: project.title, heading: HeadingLevel.TITLE }),
      new Paragraph({ text: `Thể loại: ${project.params.genres.join(', ')} · Tông giọng: ${project.params.tone} · ${chapters.length} chương đã viết`, spacing: { after: 240 } }),
      new Paragraph({ text: 'ĐẠI CỤC', heading: HeadingLevel.HEADING_1 }),
      ...String(project.generalSummary || '').split(/\n+/).filter(Boolean).map(line => new Paragraph({ text: line })),
    ];
    if (includeBible && project.progressionSummary) {
      paragraphs.push(new Paragraph({ text: 'THIÊN CƠ LỤC', heading: HeadingLevel.HEADING_1 }));
      String(project.progressionSummary).split(/\n+/).filter(Boolean).forEach(line => paragraphs.push(new Paragraph({ text: line })));
    }
    chapters.forEach(chapter => {
      paragraphs.push(new Paragraph({ text: `Chương ${chapter.index}: ${chapter.title}`, heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));
      String(chapter.content || '').split(/\n\s*\n/).forEach(block => {
        block.split('\n').map(line => line.trim()).filter(Boolean).forEach(line => paragraphs.push(new Paragraph({ text: line, spacing: { after: 120 } })));
      });
    });
    const blob = await Packer.toBlob(new Document({ sections: [{ children: paragraphs }] }));
    downloadBlobFile(`BanThao_${safeProjectFileName(project)}.docx`, blob);
  };

  const handleExportLibraryBackup = () => {
    const payload = {
      app: 'ButNghienAI',
      kind: 'library-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      projects,
    };
    downloadTextFile(`ButNghien_SaoLuuToanBo_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  };

  const handleDuplicateProject = (project: StoryProject, e: React.MouseEvent) => {
    e.stopPropagation();
    const copy: StoryProject = {
      ...project,
      id: crypto.randomUUID(),
      title: `${project.title} (bản sao)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setProjects(prev => [copy, ...prev]);
    setCloudStatus(`Đã nhân bản "${project.title}" thành "${copy.title}".`);
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
      chapters: repairVolumeChapterPlans({ ...plannedArc, chapters: sortChapters([...mergedPlans, ...extraExisting]) }).chapters,
    };
  };

  const ensureArcChapterPlans = async (arcIndex: number): Promise<Volume> => {
    const currentArc = volumes.find(volume => volume.index === arcIndex);
    if (!currentArc) throw new Error('Không tìm thấy Arc trong lộ trình.');
    if (hasCompleteArcChapterPlan(currentArc)) return getCleanArcForPrompt(currentArc);

    const cleanArc = getCleanArcForPrompt(currentArc);
    setGenerationStatus(`Đang lập bản đồ chương cho ${cleanArc.title}...`);
    const plannedArc = await generateChapterPlansForArc(params, worldBible, generalSummary, cleanArc, writtenChaptersRef.current.length ? writtenChaptersRef.current : writtenChapters);
    const mergedArc = mergeArcPlans(cleanArc, plannedArc);
    const latestVolumes = volumesRef.current.length ? volumesRef.current : volumes;
    const updatedVolumes = latestVolumes.map(volume => volume.index === arcIndex ? mergedArc : volume);
    volumesRef.current = updatedVolumes;
    setVolumes(updatedVolumes);
    setProjects(prevProjects => prevProjects.map(project => project.id === activeProjectId
      ? { ...project, volumes: updatedVolumes, updatedAt: Date.now() }
      : project
    ));
    return mergedArc;
  };

  const persistChapterContent = async (finalContent: string, currentArc: Volume, volumesForSave?: Volume[], options?: { chapterIndex?: number; bible?: string }) => {
    const chapterIndexForSave = options?.chapterIndex ?? currentChapterIndex;
    const baseVolumes = volumesForSave || (volumesRef.current.length ? volumesRef.current : volumes);
    const baseWritten = writtenChaptersRef.current.length ? writtenChaptersRef.current : writtenChapters;
    const chapterPlan = currentArc.chapters?.find(ch => ch.index === chapterIndexForSave);
    const targetWords = chapterPlan?.targetWords || params.length;
    const finalWords = countWords(finalContent);
    const hardMinimumWords = Math.max(650, Math.floor(targetWords * 0.95));
    if (finalWords < hardMinimumWords || isLikelyCutOffText(finalContent)) {
      throw new Error(`Chương đang bị thiếu phần cuối hoặc chưa đủ chữ: hiện khoảng ${finalWords}/${targetWords} chữ. App chưa lưu bản này để tránh mất nội dung.`);
    }
    const repetitionIssues = detectDraftRepetition(finalContent);
    if (repetitionIssues.length) {
      throw new Error(`Chương còn ${repetitionIssues.length} đoạn/câu bị lặp gần như nguyên văn. App chưa lưu bản này — hãy viết lại vùng bị lặp rồi lưu lại.`);
    }

    setGenerationStatus('Đang lưu chương và cập nhật Thiên Cơ Lục...');
    // Khi viet lai chuong da co: phai cap nhat canon tu bible TRUOC chuong do (snapshot cua chuong truoc),
    // neu khong du kien cua ban cu va ban moi se cung ton tai trong Thien Co Luc.
    const previousSnapshot = [...baseWritten]
      .filter(c => c.index < chapterIndexForSave && c.bibleSnapshot)
      .sort((a, b) => b.index - a.index)[0]?.bibleSnapshot;
    const isRewritePersist = baseWritten.some(c => c.index === chapterIndexForSave && c.content);
    const baseBible = isRewritePersist && previousSnapshot ? previousSnapshot : (options?.bible ?? worldBible);
    let updates: { chapterTitle?: string; chapterSummary?: string; updatedBible: string };
    let bibleUpdateError: string | null = null;
    try {
      updates = await updateWorldBibleAndSummary(baseBible, finalContent, chapterIndexForSave, generalSummary, params, currentArc);
    } catch (updateError) {
      console.warn('Không cập nhật được Thiên Cơ Lục, vẫn lưu chương đã viết:', updateError);
      bibleUpdateError = updateError instanceof Error ? updateError.message : 'lỗi không rõ';
      updates = {
        chapterTitle: chapterPlan?.title || `Chương ${chapterIndexForSave}`,
        chapterSummary: chapterPlan?.summary || finalContent.slice(0, 240),
        updatedBible: baseBible,
      };
    }

    const extracted = extractGeneratedTitle(finalContent, updates.chapterTitle || chapterPlan?.title || `Chương ${chapterIndexForSave}`);
    const finalTitle = updates.chapterTitle || extracted.title;
    const actualText = extracted.body;

    const existingChapter = baseWritten.find(chapter => chapter.index === chapterIndexForSave);
    const contentChanged = Boolean(existingChapter?.content && existingChapter.content !== actualText);
    const newChapter: Chapter = {
      ...chapterPlan,
      index: chapterIndexForSave,
      title: finalTitle,
      content: actualText,
      summary: updates.chapterSummary || chapterPlan?.summary || '',
      bibleSnapshot: updates.updatedBible,
      biblePending: bibleUpdateError ? true : undefined,
      biblePendingReason: bibleUpdateError || undefined,
      targetWords: chapterPlan?.targetWords || params.length,
      writtenAt: Date.now(),
      // Giu ban truoc moi khi noi dung bi ghi de (ke ca Cum 3 viet lai) de tac gia xem/khoi phuc.
      previousContent: contentChanged ? existingChapter?.content : existingChapter?.previousContent,
      previousContentAt: contentChanged ? Date.now() : existingChapter?.previousContentAt,
    };

    const nextWrittenList = baseWritten.some(c => c.index === newChapter.index)
      ? sortChapters(baseWritten.map(c => c.index === newChapter.index ? newChapter : c))
      : sortChapters([...baseWritten, newChapter]);

    const updatedVolumes = baseVolumes.map(v => {
      if (v.index === currentArc.index) {
        const existingInVol = v.chapters || [];
        const isChapterInVol = existingInVol.some(c => c.index === newChapter.index);
        return {
          ...v,
          chapters: isChapterInVol
            ? sortChapters(existingInVol.map(c => c.index === newChapter.index ? { ...c, ...newChapter } : c))
            : sortChapters([...existingInVol, newChapter]),
        };
      }
      return v;
    });

    // Tia bibleSnapshot: moi chuong mang mot ban bible day du (~17-20k ky tu) lam payload phinh
    // theo cap so nhan (sach 1.000 chuong ~ 20M ky tu chi rieng snapshot). Chi giu snapshot o:
    // chuong vua luu, chuong viet moi nhat + chuong lien truoc, chuong cuoi moi Arc da viet va
    // chuong dang cho cap nhat bible (can lam base cho nut chay lai). Rollback khi xoa chuong
    // dung snapshot moc gan nhat phia truoc — van dung ham tim san co trong handleDeleteChapter.
    const keepSnapshotIndexes = new Set<number>([newChapter.index]);
    const sortedWrittenIndexes = nextWrittenList.map(chapter => chapter.index).sort((x, y) => x - y);
    if (sortedWrittenIndexes.length) {
      keepSnapshotIndexes.add(sortedWrittenIndexes[sortedWrittenIndexes.length - 1]);
      if (sortedWrittenIndexes.length > 1) keepSnapshotIndexes.add(sortedWrittenIndexes[sortedWrittenIndexes.length - 2]);
    }
    nextWrittenList.forEach(chapter => { if (chapter.biblePending) keepSnapshotIndexes.add(chapter.index); });
    updatedVolumes.forEach(volume => {
      const writtenInArc = (volume.chapters || []).filter(chapter => chapter.content).map(chapter => chapter.index);
      if (writtenInArc.length) keepSnapshotIndexes.add(Math.max(...writtenInArc));
    });
    const pruneSnapshot = (chapter: Chapter): Chapter =>
      chapter.bibleSnapshot && !keepSnapshotIndexes.has(chapter.index) ? { ...chapter, bibleSnapshot: undefined } : chapter;
    const prunedWrittenList = nextWrittenList.map(pruneSnapshot);
    const prunedVolumes = updatedVolumes.map(volume => ({ ...volume, chapters: (volume.chapters || []).map(pruneSnapshot) }));

    writtenChaptersRef.current = prunedWrittenList;
    volumesRef.current = prunedVolumes;
    setWrittenChapters(prunedWrittenList);
    setWorldBible(updates.updatedBible);
    setStory(actualText);
    setVolumes(prunedVolumes);
    clearDraftPipeline();
    setProjects(prevProjects => prevProjects.map(p => p.id === activeProjectId
      ? { ...p, volumes: prunedVolumes, progressionSummary: updates.updatedBible, lastChapterWritten: Math.max(0, ...prunedWrittenList.map(chapter => chapter.index)), updatedAt: Date.now() }
      : p
    ));
    if (bibleUpdateError) {
      setCloudStatus(`⚠ Chương ${chapterIndexForSave} đã lưu nhưng Thiên Cơ Lục chưa cập nhật được (${bibleUpdateError}). Chương sau có thể lệch canon — hãy thẩm định lại trước khi viết tiếp.`);
    }
    return { updatedBible: updates.updatedBible, chapter: newChapter };
  };
  const handleRetryBibleUpdate = async () => {
    if (isRetryingBible || isGenerating) return;
    const allWritten = writtenChaptersRef.current.length ? writtenChaptersRef.current : writtenChapters;
    const pending = sortChapters(allWritten.filter(c => c.biblePending));
    if (!pending.length) return;
    const startIndex = pending[0].index;
    const replayList = sortChapters(allWritten.filter(c => c.index >= startIndex && c.content));
    if (!replayList.length) return;
    setIsRetryingBible(true);
    try {
      // Snapshot cua chuong cho chinh la bible TRUOC chuong do (persist luu base khi that bai),
      // nen chay lai tu do la dung chuoi canon. Cac chuong sau phai chay lai cung de khong lech chuoi.
      let base = replayList[0].bibleSnapshot
        || [...allWritten].filter(c => c.index < startIndex && c.bibleSnapshot).sort((x, y) => y.index - x.index)[0]?.bibleSnapshot
        || worldBible;
      const updatedByIndex = new Map<number, Chapter>();
      let failedReason: string | null = null;
      let failedChapterIndex: number | null = null;
      for (let i = 0; i < replayList.length; i++) {
        const chapter = replayList[i];
        setGenerationStatus(`Đang cập nhật lại Thiên Cơ Lục: chương ${chapter.index} (${i + 1}/${replayList.length})...`);
        const arc = getArcByChapterIndex(chapter.index) || getActiveArc();
        try {
          const updates = await updateWorldBibleAndSummary(base, chapter.content || '', chapter.index, generalSummary, params, arc || undefined, true);
          updatedByIndex.set(chapter.index, {
            ...chapter,
            summary: updates.chapterSummary || chapter.summary,
            bibleSnapshot: updates.updatedBible,
            biblePending: undefined,
            biblePendingReason: undefined,
          });
          base = updates.updatedBible;
        } catch (retryError) {
          failedReason = retryError instanceof Error ? retryError.message : 'lỗi không rõ';
          failedChapterIndex = chapter.index;
          updatedByIndex.set(chapter.index, { ...chapter, biblePending: true, biblePendingReason: failedReason });
          break;
        }
      }
      const nextWritten = sortChapters(allWritten.map(c => updatedByIndex.get(c.index) || c));
      writtenChaptersRef.current = nextWritten;
      setWrittenChapters(nextWritten);
      setWorldBible(base);
      const baseVolumes = volumesRef.current.length ? volumesRef.current : volumes;
      const updatedVolumes = baseVolumes.map(v => ({
        ...v,
        chapters: (v.chapters || []).map(c => {
          const u = updatedByIndex.get(c.index);
          return u ? { ...c, summary: u.summary, bibleSnapshot: u.bibleSnapshot, biblePending: u.biblePending, biblePendingReason: u.biblePendingReason } : c;
        }),
      }));
      volumesRef.current = updatedVolumes;
      setVolumes(updatedVolumes);
      setProjects(prevProjects => prevProjects.map(p => p.id === activeProjectId
        ? { ...p, volumes: updatedVolumes, progressionSummary: base, updatedAt: Date.now() }
        : p
      ));
      if (failedReason) {
        setCloudStatus(`⚠ Cập nhật lại Thiên Cơ Lục dừng ở chương ${failedChapterIndex}: ${failedReason}`);
        alert(`Chưa cập nhật xong Thiên Cơ Lục: ${failedReason}`);
      } else {
        setCloudStatus(`✓ Thiên Cơ Lục đã được cập nhật lại đầy đủ từ chương ${startIndex}.`);
      }
    } finally {
      setIsRetryingBible(false);
      setGenerationStatus('');
    }
  };

  const handleWriteChapter = async () => {
    if (isGenerating || isGeneratingOutline) return;
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
    clearDraftPipeline();

    if (params.projectType === 'Truyện Ngắn') {
      try {
        setGenerationStatus('Đang viết truyện ngắn hoàn chỉnh...');
        const fullText = await generateShortStoryStream(params, (chunk) => setStory(prev => prev + chunk), chapterIdea);
        if (!fullText.trim()) throw new Error('Gemini chưa trả về nội dung truyện. Hãy thử lại với mục tiêu chữ thấp hơn hoặc bấm viết lại.');

        const extracted = extractGeneratedTitle(fullText, writtenChapters[0]?.title || 'Toàn văn');
        const shortStoryWords = countWords(extracted.body);
        const shortStoryMinimum = Math.max(700, Math.floor(params.length * 0.92));
        if (shortStoryWords < shortStoryMinimum || isLikelyCutOffText(extracted.body)) {
          throw new Error(`Bản truyện đang bị thiếu phần cuối hoặc chưa đủ chữ: hiện khoảng ${shortStoryWords}/${params.length} chữ. Hãy bấm viết lại để app nối tiếp bản đầy đủ hơn.`);
        }
        setGenerationStatus('Đang thẩm định logic truyện ngắn...');
        await validateShortStoryDraft(extracted.body, extracted.title, params);
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
    
    try {
      let currentArc = chapterArc || { index: activeArcIndex, title: 'Tự do', summary: 'Không có lộ trình cụ thể.', chapters: [] };
      if (params.projectType === 'Trường Thiên' && !hasCompleteArcChapterPlan(currentArc as Volume)) {
        currentArc = await ensureArcChapterPlans(currentArc.index);
      }
      setActiveArcIndex(currentArc.index);
      const chapterPlan = currentArc.chapters?.find(ch => ch.index === currentChapterIndex);
      const targetWords = chapterPlan?.targetWords || params.length;

      setGenerationStatus(`Đang chấp bút Chương ${currentChapterIndex} theo bản đồ chương...`);
      const finalContent = await generateChapterStream(
        params,
        writtenChapters,
        currentChapterIndex,
        worldBible,
        chapterIdea,
        generalSummary,
        currentArc,
        (chunk) => setStory(prev => prev + chunk),
        false,
      );
      if (!finalContent.trim()) throw new Error('Gemini chưa trả về nội dung chương. Hãy thử lại hoặc giảm mục tiêu số chữ.');

      const draftWords = countWords(finalContent);
      const draftMinimumWords = Math.max(650, Math.floor(targetWords * 0.95));
      if (draftWords < draftMinimumWords || isLikelyCutOffText(finalContent)) {
        setStory('');
        throw new Error(`Bản nháp Cụm 1 đang thiếu phần cuối hoặc chưa đủ chữ: hiện khoảng ${draftWords}/${targetWords} chữ. App chưa gọi Cụm 2/3 và chưa lưu bản này.`);
      }

      setGenerationStatus('Bản nháp Cụm 1 đã đủ chữ. Đang lưu vào bản thảo chính...');
      await persistChapterContent(finalContent, currentArc);
      setPendingDraftMeta({ chapterIndex: currentChapterIndex, arcIndex: currentArc.index });
      setDraftAutosavedMeta({ chapterIndex: currentChapterIndex, arcIndex: currentArc.index });
      setDraftReview(null);
      setRevisionRequest('');
      setGenerationStatus('Đã lưu chương vào Bản thảo. Tác giả có thể đọc, gọi Cụm 2 thẩm định hoặc Cụm 3 sửa sau nếu cần.');
    } catch (e) { 
        console.error(e);
        const message = e instanceof Error ? e.message : '';
        if (/chưa hoàn tất|cụt|thiếu phần cuối|chưa đủ chữ|không trả về nội dung|chưa trả về nội dung/i.test(message)) {
          setStory('');
        }
        alert(friendlyError(e)); 
    }
    finally { setIsGenerating(false); setGenerationStatus(''); }
  };

  const chapterReviewNeedsRewrite = (review: ChapterValidationResult | null, authorNote = '') => {
    if (!review) return Boolean(authorNote.trim());
    if (review.unverified) return Boolean(authorNote.trim());
    return !review.isValid
      || Boolean(authorNote.trim())
      || Boolean(review.fixPlan)
      || [
        review.setupIssues,
        review.structureIssues,
        review.logicIssues,
        review.canonIssues,
        review.povIssues,
        review.metricIssues,
        review.ramblingIssues,
        review.styleIssues,
        review.repetitionIssues,
        review.dictionIssues,
        review.suggestions,
        review.rewriteDirectives,
      ].some(group => Boolean(group?.length));
  };

  const handleSaveCurrentDraft = async () => {
    if (!story.trim()) {
      alert('Chưa có bản nháp để lưu.');
      return;
    }
    const currentArc = getArcByChapterIndex(currentChapterIndex) || getActiveArc();
    if (!currentArc) {
      alert('Không tìm thấy Arc của chương hiện tại.');
      return;
    }
    setIsGenerating(true);
    try {
      await persistChapterContent(story, currentArc);
      setPendingDraftMeta({ chapterIndex: currentChapterIndex, arcIndex: currentArc.index });
      setDraftAutosavedMeta({ chapterIndex: currentChapterIndex, arcIndex: currentArc.index });
    } catch (error) {
      console.error(error);
      alert(friendlyError(error));
    } finally {
      setIsGenerating(false);
      setGenerationStatus('');
    }
  };

  const handleReviewDraft = async () => {
    if (!story.trim()) {
      alert('Chưa có bản nháp Cụm 1 để thẩm định.');
      return;
    }
    const currentArc = getArcByChapterIndex(currentChapterIndex) || getActiveArc();
    if (!currentArc) {
      alert('Không tìm thấy Arc của chương hiện tại.');
      return;
    }

    const originalDraft = story;
    const previousForValidation = writtenChapters.filter(ch => ch.index !== currentChapterIndex);
    setIsGenerating(true);

    try {
      setGenerationStatus('Cụm 2 đang thẩm định bản nháp Cụm 1...');
      const validation = await validateChapterLogic(originalDraft, previousForValidation, worldBible, currentArc, generalSummary, params, currentChapterIndex);
      setDraftReview(validation);
      setGenerationStatus('Cụm 2 đã thẩm định xong. Tác giả đọc báo cáo rồi quyết định lưu hoặc gọi Cụm 3.');
    } catch (error) {
      console.error(error);
      alert(friendlyError(error));
    } finally {
      setIsGenerating(false);
      setGenerationStatus('');
    }
  };

  const handleRewriteReviewedDraft = async () => {
    if (!story.trim()) {
      alert('Chưa có bản nháp để Cụm 3 viết lại.');
      return;
    }
    if (!draftReview) {
      alert('Hãy cho Cụm 2 thẩm định trước, rồi Cụm 3 mới viết lại theo báo cáo.');
      return;
    }
    const currentArc = getArcByChapterIndex(currentChapterIndex) || getActiveArc();
    if (!currentArc) {
      alert('Không tìm thấy Arc của chương hiện tại.');
      return;
    }

    const originalDraft = story;
    const authorNote = revisionRequest.trim();
    if (!chapterReviewNeedsRewrite(draftReview, authorNote)) {
      alert('Cụm 2 chưa thấy lỗi cần sửa. Bạn có thể lưu bản nháp này, hoặc nhập yêu cầu thêm rồi bấm Cụm 3 viết lại.');
      return;
    }

    setIsGenerating(true);
    try {
      setGenerationStatus('Cụm 3 đang viết lại theo báo cáo Cụm 2 và yêu cầu tác giả...');
      setStory('');
      let rewriteDiscardedReason = '';
      const rewritten = await rewriteChapterWithReviewStream(
        params,
        writtenChapters,
        currentChapterIndex,
        worldBible,
        authorNote || chapterIdea,
        generalSummary,
        currentArc,
        originalDraft,
        draftReview,
        (chunk) => setStory(prev => prev + chunk),
        (reason) => { rewriteDiscardedReason = reason; },
      );
      if (rewriteDiscardedReason) {
        setCloudStatus(`⚠ Cụm 3 chưa đạt chuẩn nên bản sửa đã bị loại (${rewriteDiscardedReason}). Chương được lưu là bản Cụm 1 đã giữ — bạn có thể thẩm định lại hoặc chạy Cụm 3 lần nữa.`);
      }
      const targetWords = currentArc.chapters?.find(ch => ch.index === currentChapterIndex)?.targetWords || params.length;
      const rewrittenWords = countWords(rewritten);
      if (rewrittenWords < Math.max(650, Math.floor(targetWords * 0.95)) || isLikelyCutOffText(rewritten)) {
        setStory(originalDraft);
        throw new Error(`Bản sửa Cụm 3 vẫn thiếu phần cuối hoặc chưa đủ chữ: hiện khoảng ${rewrittenWords}/${targetWords} chữ. App chưa lưu bản này.`);
      }
      setGenerationStatus(rewriteDiscardedReason ? 'Đang lưu bản Cụm 1 đã giữ vào bản thảo chính...' : 'Cụm 3 đã viết lại. Đang lưu bản sửa vào bản thảo chính...');
      await persistChapterContent(rewritten, currentArc);
      setPendingDraftMeta({ chapterIndex: currentChapterIndex, arcIndex: currentArc.index });
      setDraftAutosavedMeta({ chapterIndex: currentChapterIndex, arcIndex: currentArc.index });
      setDraftReview(null);
      setRevisionRequest('');
    } catch (error) {
      console.error(error);
      setStory(originalDraft);
      const savedNotice = currentDraftIsAutosaved
        ? '\n\nBản trước đó vẫn đã nằm trong Bản thảo/Tàng thư. Bạn có thể kiểm tra kho key rồi bấm Cụm 3 lại, hoặc giữ bản hiện tại.'
        : '\n\nBản nháp Cụm 1 vẫn được giữ trên màn hình. Bạn có thể bấm Lưu bản này hoặc kiểm tra kho key rồi thử Cụm 3 lại.';
      alert(`${friendlyError(error)}${isGeminiKeyInfrastructureError(error) ? savedNotice : ''}`);
    } finally {
      setIsGenerating(false);
      setGenerationStatus('');
    }
  };

  const generateProjectFromParams = async (workingParams: StoryParams) => {
    setParams(workingParams);
    clearDraftPipeline();
    setActiveProjectId(null);
    setVolumes([]);
    setWrittenChapters([]);
    setGeneralSummary('');
    setWorldBible('');
    setStory('');
    setChapterIdea('');
    setCurrentChapterIndex(1);
    setActiveArcIndex(1);
    setIsGeneratingOutline(true);
    setGenerationStatus(workingParams.projectType === 'Truyện Ngắn' ? 'Đang viết truyện ngắn hoàn chỉnh...' : 'Bước 1/3: Đang lập Đại cục và phân bổ Arc...');
    setLogicReport(null);
    try {
      if (workingParams.projectType === 'Truyện Ngắn') {
        setView('editor');
        setStory('');
        const fullText = await generateShortStoryStream(workingParams, (chunk) => setStory(prev => prev + chunk));
        const extracted = extractGeneratedTitle(fullText, 'Toàn văn');
        const shortStoryWords = countWords(extracted.body);
        const shortStoryMinimum = Math.max(700, Math.floor(workingParams.length * 0.92));
        if (shortStoryWords < shortStoryMinimum || isLikelyCutOffText(extracted.body)) {
          throw new Error(`Bản truyện đang bị thiếu phần cuối hoặc chưa đủ chữ: hiện khoảng ${shortStoryWords}/${workingParams.length} chữ. Hãy bấm viết lại để app nối tiếp bản đầy đủ hơn.`);
        }
        setGenerationStatus('Đang thẩm định logic truyện ngắn...');
        await validateShortStoryDraft(extracted.body, extracted.title, workingParams);
        const newId = crypto.randomUUID();
        const shortChapter: Chapter = { index: 1, title: extracted.title, content: extracted.body, summary: workingParams.seed || '', targetWords: workingParams.length };
        const shortVolume: Volume = { index: 1, title: 'Truyện ngắn', summary: 'Nội dung truyện ngắn hoàn chỉnh', chapterStart: 1, chapterEnd: 1, chapters: [shortChapter] };
        const newProj: StoryProject = { 
          id: newId, title: extracted.title || projectTitleFromSeed(workingParams.seed || ''), params: workingParams, 
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
        const initialSummary = result.generalSummary || workingParams.seed || '';
        const initialBible = buildOpeningWorldBible(result.worldBuilding || '', initialSummary, workingParams, initialVolumes);
        setGenerationStatus('Bước 3/3: Đang mở bàn viết và lưu dự án...');
        setVolumes(initialVolumes);
        setWrittenChapters([]);
        setGeneralSummary(initialSummary);
        setWorldBible(initialBible);
        setCurrentChapterIndex(1);
        setActiveArcIndex(1);
        const newId = crypto.randomUUID();
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

  const handleStartProject = async () => {
    const validationError = validateSetupParams(params);
    if (validationError) return alert(validationError);

    const workingParams = normalizeParams(params);
    setParams(workingParams);
    setLogicReport(null);

    if (workingParams.projectType === 'Truyện Ngắn' || workingParams.directionLock) {
      await generateProjectFromParams(workingParams);
      return;
    }

    setIsGeneratingOutline(true);
    setGenerationStatus('Key 6 đang đọc hồ sơ và tạo 10 hướng truyện...');
    setPendingDirectionParams(workingParams);
    setDirectionChoices([]);
    setSelectedDirectionId('');
    try {
      const choices = await generateStoryDirectionChoices(workingParams);
      setDirectionChoices(choices);
      setSelectedDirectionId(choices[0]?.id || '');
      setView('directions');
    } catch (error) {
      console.error(error);
      alert(friendlyError(error));
    } finally {
      setIsGeneratingOutline(false);
      setGenerationStatus('');
    }
  };

  const handleChooseDirection = async (choice: StoryDirectionChoice) => {
    if (isGenerating || isGeneratingOutline) return;
    const baseParams = pendingDirectionParams || normalizeParams(params);
    const lockedParams = lockDirectionIntoParams(baseParams, choice);
    setSelectedDirectionId(choice.id);
    setPendingDirectionParams(null);
    setDirectionChoices([]);
    await generateProjectFromParams(lockedParams);
  };

  const handleAddNextArc = async () => {
    if (isGenerating || isGeneratingOutline) return;
    if (getConfiguredGeminiKeyCount() === 0) return alert('Chưa có Gemini key khả dụng. Hãy kiểm tra các biến GEMINI_API_KEY_* trên Vercel rồi redeploy hoặc khởi động lại server.');
    // Mo rong vuot ke hoach la tinh nang co chu dich (generateNextArc co nhanh extension rieng),
    // nhung khong duoc lang le nhu truoc (test live: sach 3 chuong tu doi thanh 8 chuong).
    // Lo trinh da phu du so chuong thi hoi xac nhan ro rang truoc khi mo rong.
    const coveredChapterEnd = volumes.reduce((max, volume) => Math.max(max, volume.chapterEnd || 0), 0);
    if (coveredChapterEnd >= params.totalChapters) {
      const confirmed = window.confirm(`Lộ trình hiện tại đã phủ đủ ${params.totalChapters} chương theo thiết lập. Thêm Arc mới sẽ MỞ RỘNG sách vượt kế hoạch ban đầu — tổng số chương sẽ tăng theo Arc mới. Tiếp tục?`);
      if (!confirmed) return;
    }
    setIsGeneratingOutline(true);
    setGenerationStatus('Đang lập Arc mở rộng dựa trên Đại cục và Thiên Cơ Lục...');
    try {
      const nextVol = await generateNextArc(params, worldBible, volumes, writtenChapters, generalSummary);
      const expandedTotalChapters = Math.min(MAX_TOTAL_CHAPTERS, Math.max(params.totalChapters, nextVol.chapterEnd || params.totalChapters));
      const nextParams = expandedTotalChapters !== params.totalChapters
        ? { ...params, totalChapters: expandedTotalChapters }
        : params;
      const updatedVolumes = [...volumes, nextVol];
      if (nextParams !== params) setParams(nextParams);
      setVolumes(updatedVolumes);
      // Dai cuoc dung yen tu luc tao trong khi Thien Co Luc va ban thao tien hoa — moi lan sang
      // Arc moi, lam moi Dai cuc tu bible hien tai + dien tien da viet (loi thi giu ban cu).
      let refreshedSummary = '';
      if (writtenChapters.length > 0) {
        try {
          refreshedSummary = await refreshGeneralSummary(nextParams, worldBible, updatedVolumes, writtenChapters, generalSummary);
        } catch { refreshedSummary = ''; }
      }
      if (refreshedSummary && refreshedSummary !== generalSummary) {
        setGeneralSummary(refreshedSummary);
        setCloudStatus('Đã làm mới Đại cục theo Thiên Cơ Lục và diễn tiến đã viết.');
      }
      setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, params: nextParams, volumes: updatedVolumes, ...(refreshedSummary ? { generalSummary: refreshedSummary } : {}), updatedAt: Date.now() } : p));
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
    if (isGenerating || isGeneratingOutline) return;
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
      clearDraftPipeline();
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
      clearDraftPipeline();
    }
    setView('editor');
  };

  const handleWriteNextChapter = async () => {
    const availableIndexes = Array.from({ length: Math.max(0, params.totalChapters) }, (_, index) => index + 1)
      .filter(index => plannedChapterIndexes.has(index) && !writtenChapterIndexes.has(index));
    const nextIndex = availableIndexes.find(index => index > currentChapterIndex) || availableIndexes[0];
    if (!nextIndex) {
      // Ban do chi tiet sinh theo tung Arc: het chuong DA CO ban do khong co nghia la het truyen.
      // Mo luong chuan bi viet de tu lap ban do cho Arc ke tiep thay vi bao "het chuong".
      await openEditorWithGuard();
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
    clearDraftPipeline();
    setView('editor');
  };

  const handleReadChapter = (chapter: Chapter, arcIndex: number) => {
    clearDraftPipeline(); setStory(chapter.content || ''); setCurrentChapterIndex(chapter.index); setActiveArcIndex(arcIndex); setView('editor');
  };

  const handleRewriteChapter = (chapter: Chapter, arcIndex: number) => {
    clearDraftPipeline(); setCurrentChapterIndex(chapter.index); setActiveArcIndex(arcIndex); setChapterIdea(''); setStory(''); setView('editor');
  };

  const handleDeleteChapter = (chapterIndex: number, _arcIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`⚠️ Xóa vĩnh viễn nội dung chương ${chapterIndex}?`)) {
      const nextWrittenList = writtenChapters.filter(c => c.index !== chapterIndex);
      // Rollback canon ve snapshot cua chuong truoc chuong bi xoa, tranh du kien "ma" cua ban da xoa.
      const previousSnapshot = [...writtenChapters]
        .filter(c => c.index < chapterIndex && c.bibleSnapshot)
        .sort((a, b) => b.index - a.index)[0]?.bibleSnapshot;
      const updatedVolumes = volumes.map(v => ({
        ...v,
        chapters: (v.chapters || []).map(c => c.index === chapterIndex
          ? { ...c, content: undefined, bibleSnapshot: undefined }
          : c
        )
      }));
      setWrittenChapters(nextWrittenList);
      setVolumes(updatedVolumes);
      if (chapterIndex === currentChapterIndex) {
        setStory('');
        clearDraftPipeline();
      }
      if (previousSnapshot) setWorldBible(previousSnapshot);
      setProjects(prevProjects => prevProjects.map(p => p.id === activeProjectId
        ? { ...p, volumes: updatedVolumes, ...(previousSnapshot ? { progressionSummary: previousSnapshot } : {}), lastChapterWritten: Math.max(0, ...nextWrittenList.map(chapter => chapter.index)), updatedAt: Date.now() }
        : p
      ));
    }
  };

  const handleRestorePreviousContent = (chapter: Chapter) => {
    if (!chapter.previousContent) return;
    if (!window.confirm(`Khôi phục bản trước của Chương ${chapter.index}? Bản hiện tại sẽ trở thành "bản trước" để bạn quay lại được. Lưu ý: Thiên Cơ Lục đang khớp với bản hiện tại — sau khi khôi phục nên chạy kiểm tra logic.`)) return;
    const swapped: Chapter = {
      ...chapter,
      content: chapter.previousContent,
      previousContent: chapter.content,
      previousContentAt: Date.now(),
      writtenAt: Date.now(),
    };
    const nextWritten = sortChapters(writtenChapters.map(item => item.index === chapter.index ? swapped : item));
    const nextVolumes = volumes.map(volume => ({
      ...volume,
      chapters: (volume.chapters || []).map(item => item.index === chapter.index ? { ...item, ...swapped } : item),
    }));
    writtenChaptersRef.current = nextWritten;
    volumesRef.current = nextVolumes;
    setWrittenChapters(nextWritten);
    setVolumes(nextVolumes);
    if (chapter.index === currentChapterIndex) setStory(swapped.content || '');
    setProjects(prev => prev.map(project => project.id === activeProjectId ? { ...project, volumes: nextVolumes, updatedAt: Date.now() } : project));
    setCloudStatus(`Đã khôi phục bản trước của Chương ${chapter.index}.`);
  };

  const handlePrefillSample = () => {
    setParams(prev => ({
      ...prev,
      projectType: 'Trường Thiên',
      totalChapters: 12,
      length: 1200,
      genres: ['Tiên hiệp', 'Hài hước'] as Genre[],
      tone: 'Hài hước' as Tone,
      seed: 'Một đệ tử tạp dịch nhặt được nghiên mực cổ có thể viết lại một dòng Thiên Cơ Lục mỗi ngày — nhưng mỗi lần viết, một ký ức của cậu bị mực ăn mất. Cậu phải leo lên đỉnh tông môn trước khi quên mất lý do mình bắt đầu.',
      narrativeView: 'Ngôi thứ ba hạn chế bám nhân vật chính',
      character: {
        ...prev.character,
        name: 'Tiểu Mãn',
        personality: 'Lém lỉnh, gan dạ, hay gây họa nhưng trọng nghĩa khí',
        goal: 'Trở thành chân truyền đệ tử và giữ lại ký ức về người thầy đầu tiên',
      },
    }));
    setView('setup');
    setCloudStatus('Đã điền hồ sơ mẫu — sửa tự do rồi bấm khóa hồ sơ để thử luồng viết.');
  };

  const handleDeleteProject = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm("⚠️ Bạn có chắc chắn muốn xóa vĩnh viễn tác phẩm này khỏi Tàng Thư local và Firebase?")) {
      tombstonesRef.current[id] = Date.now();
      writeLocalTombstone(id);
      void recordDeletedProjectOnFirebase(id).catch(() => undefined);
      lastPushedRef.current.delete(id);
      void Promise.allSettled([deleteProjectFromDb(id), deleteProjectFromFirebase(id)]).then(results => {
        if (results.some(result => result.status === 'rejected')) {
          setCloudStatus('Xóa tác phẩm chưa hoàn tất ở một nơi lưu — kiểm tra lại khi mở app lần sau.');
        }
      });
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
    const loadedVolumes = (p.volumes || []).map(v => repairVolumeChapterPlans({ ...v, chapters: sortChapters(v.chapters || []) }));
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
    if (!content) return <p className="text-stone-400 italic">Thiên cơ đang thành hình...</p>;
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
            <div key={idx} className={`relative p-8 rounded-3xl border ${isLogic ? 'bg-amber-50/50 border-orange-200' : 'bg-white border-stone-100 shadow-sm'} transition-all hover:shadow-md group`}>
              <div className="flex items-center gap-3 mb-4">
                 <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-white ${isLogic ? 'bg-orange-600' : 'bg-stone-800'}`}>
                    {idx + 1}
                 </div>
                 <h3 className={`font-black uppercase tracking-widest text-sm story-font ${isLogic ? 'text-stone-900' : 'text-stone-900'}`}>{title || "Chi tiết"}</h3>
              </div>
              <div className={`story-font text-lg leading-relaxed whitespace-pre-wrap ${isLogic ? 'italic text-orange-700' : 'text-stone-700'}`}>
                {body}
              </div>
              {isLogic && (
                <div className="absolute -bottom-4 -right-4 w-16 h-16 bg-white border-2 border-orange-600 rounded-full flex items-center justify-center rotate-12 shadow-lg border-dashed">
                  <span className="text-[8px] font-black uppercase text-orange-600 text-center leading-none">Thiên Cơ<br/>Xác Thực</span>
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
      <div className="login-scene min-h-screen text-white flex items-center justify-center p-6">
        <section className="w-full max-w-5xl grid lg:grid-cols-[1fr_0.9fr] gap-6 items-stretch">
          <div className="relative overflow-hidden rounded-[2rem] shadow-2xl flex flex-col justify-end min-h-[440px] ring-1 ring-white/25">
            <img src="/img/xianxia-hero.webp" alt="Bút lông chấm vào nghiên mực ngọc phát sáng, khói mực vàng bay lên thành nét chữ giữa cảnh tiên hiệp" className="absolute inset-0 w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#03211a]/90 via-[#03211a]/20 to-transparent"></div>
            <div className="relative p-8 md:p-12">
              <span className="inline-flex w-fit px-3 py-1 bg-white/10 border border-amber-200/40 text-amber-200 rounded-full text-[9px] font-black uppercase tracking-widest mb-6 backdrop-blur-md">Không gian riêng</span>
              <h1 className="story-font text-4xl md:text-6xl font-black italic leading-tight mb-4 text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.55)]">
                Bút Nghiên <span className="text-amber-300 not-italic">Thiên Cơ</span>
              </h1>
              <p className="story-font text-lg text-teal-50/85 leading-relaxed">
                Đăng nhập để mở Tàng Thư, dữ liệu Firebase và bàn viết của bạn.
              </p>
              <div className="grid sm:grid-cols-3 gap-3 mt-8">
                <div className="p-4 bg-white/10 border border-white/20 rounded-2xl backdrop-blur-md">
                  <span className="block text-[8px] font-black uppercase text-amber-200/80">Firebase</span>
                  <strong className="text-xs font-black text-white">{getFirebaseProjectId()}</strong>
                </div>
                <div className="p-4 bg-white/10 border border-white/20 rounded-2xl backdrop-blur-md">
                  <span className="block text-[8px] font-black uppercase text-amber-200/80">Bảo mật</span>
                  <strong className="text-xs font-black text-white">Email / mật khẩu</strong>
                </div>
                <div className="p-4 bg-white/10 border border-white/20 rounded-2xl backdrop-blur-md">
                  <span className="block text-[8px] font-black uppercase text-amber-200/80">Dữ liệu</span>
                  <strong className="text-xs font-black text-white">Theo tài khoản</strong>
                </div>
              </div>
            </div>
          </div>

          <form onSubmit={handleSignIn} className="bg-[#03211a]/60 backdrop-blur-2xl border border-white/15 text-white rounded-[2rem] p-6 md:p-8 shadow-[0_30px_80px_rgba(0,0,0,0.5)] flex flex-col justify-center gap-5">
            <div>
              <img src="/img/emblem-trim.webp" alt="Biểu tượng bút và nghiên mực" className="w-14 h-14 rounded-2xl object-cover ring-1 ring-amber-200/50 shadow-lg shadow-black/40 mb-4" />
              <span className="text-[9px] font-black uppercase text-amber-300 tracking-widest">Đăng nhập</span>
              <h2 className="text-2xl font-black story-font mt-2">Chỉ tài khoản được cấp mới vào được app</h2>
            </div>
            <label className="space-y-2">
              <span className="block text-[9px] font-black uppercase text-stone-400">Email</span>
              <input
                type="email"
                value={loginEmail}
                onChange={event => setLoginEmail(event.target.value)}
                autoComplete="email"
                className="w-full p-4 rounded-2xl bg-white/10 border border-white/10 text-white outline-none focus:ring-2 focus:ring-amber-300"
                placeholder="ban@example.com"
              />
            </label>
            <label className="space-y-2">
              <span className="block text-[9px] font-black uppercase text-stone-400">Mật khẩu</span>
              <input
                type="password"
                value={loginPassword}
                onChange={event => setLoginPassword(event.target.value)}
                autoComplete="current-password"
                className="w-full p-4 rounded-2xl bg-white/10 border border-white/10 text-white outline-none focus:ring-2 focus:ring-amber-300"
                placeholder="Mật khẩu Firebase"
              />
            </label>
            {authError && (
              <p className="p-3 rounded-2xl bg-red-500/10 border border-red-400/20 text-red-100 text-sm font-bold">
                {authError}
              </p>
            )}
            <button
              type="submit"
              disabled={isSigningIn}
              className="w-full py-4 bg-gradient-to-r from-amber-200 via-amber-400 to-amber-200 text-stone-950 rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg shadow-amber-500/25 hover:brightness-110 transition-all disabled:opacity-50"
            >
              {isSigningIn ? 'Đang kiểm tra...' : 'Mở Bút Nghiên'}
            </button>
            <p className="text-[11px] text-stone-400 leading-relaxed">
              Tài khoản được tạo trong Firebase Console. Không có tài khoản thì không thể vào app.
            </p>
          </form>
        </section>
      </div>
    );
  };

  return (
    <div className="app-shell flex flex-col md:flex-row h-screen overflow-hidden text-stone-800 font-sans">
      <aside className="control-panel w-full md:w-[360px] max-h-[48vh] md:max-h-none border-b md:border-b-0 p-4 md:p-5 flex flex-col gap-4 shrink-0 z-20 overflow-y-auto custom-scrollbar">
        <div className="flex items-center gap-3 pb-4 border-b">
          <img src="/img/emblem-trim.webp" alt="Bút Nghiên" className="w-10 h-10 rounded-xl object-cover ring-1 ring-amber-300/60 shadow-lg shadow-teal-950/30" />
          <h1 onClick={() => setView('setup')} className="text-xl font-black text-stone-900 cursor-pointer italic hover:text-orange-600 transition-all">Bút Nghiên AI</h1>
        </div>
        {isFirebaseConfigured() && authUser && (
          <div className="antique-frame p-3 rounded-xl flex items-center justify-between gap-3">
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
          <div className="antique-frame p-3 rounded-xl">
            <span className="block text-[8px] font-black uppercase text-[#96762a]">Gemini</span>
            <span className="text-xs font-black text-orange-700">{getGeminiKeyStatusLabel()}</span>
          </div>
          <div className="antique-frame p-3 rounded-xl">
            <span className="block text-[8px] font-black uppercase text-[#96762a]">Database</span>
            <span className="text-[9px] font-bold text-stone-500 line-clamp-2">{storageStatus}</span>
            {storageUsageText && <span className="block text-[8px] font-bold text-stone-400 mt-0.5">{storageUsageText}</span>}
          </div>
          <div className="antique-frame p-3 rounded-xl">
            <span className="block text-[8px] font-black uppercase text-[#96762a]">Firebase</span>
            <span className="flex items-start gap-1.5 text-[9px] font-bold text-stone-500 line-clamp-2">
              <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${/lỗi|Không tải|chưa đồng bộ/i.test(cloudStatus) ? 'bg-red-500' : /Đang lưu|Đang tải/i.test(cloudStatus) ? 'bg-amber-500 animate-pulse' : /đã|Đã/i.test(cloudStatus) ? 'bg-emerald-500' : 'bg-stone-300'}`} />
              <span className="line-clamp-2">{cloudStatus}</span>
            </span>
          </div>
        </div>
        <div className="p-4 bg-[#052e26]/85 backdrop-blur-xl border border-amber-200/20 text-white rounded-lg shadow-lg shadow-teal-950/30 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="block text-[8px] font-black uppercase text-emerald-300 tracking-widest">Quy trình</span>
              <span className="block text-xs font-black">Tạo truyện theo khóa logic</span>
            </div>
            <span className="text-[10px] font-black text-stone-300">{planCompletenessPercent}%</span>
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {workflowSteps.map(step => (
              <div key={step.label} className={`h-1.5 rounded-full ${step.status === 'done' ? 'bg-emerald-400' : step.status === 'active' ? 'bg-amber-300' : 'bg-white/10'}`} title={step.label} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {workflowSteps.map(step => (
              <div key={step.label} className={`px-2 py-1.5 rounded-lg text-[8px] font-black uppercase ${step.status === 'done' ? 'bg-emerald-400/20 text-emerald-200' : step.status === 'active' ? 'bg-amber-300/20 text-amber-100' : 'bg-white/5 text-stone-500'}`}>
                {step.label}
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-5">
          <div className="seg-antique flex p-1 rounded-xl">
            {(['Truyện Ngắn', 'Trường Thiên'] as const).map(t => (
              <button key={t} onClick={() => handleProjectTypeChange(t)} className={`flex-1 py-2 text-[10px] font-bold uppercase rounded-lg transition-all ${params.projectType === t ? 'bg-gradient-to-b from-amber-200 to-amber-400 shadow text-stone-900' : 'text-amber-100/60 hover:text-amber-100'}`}>{t}</button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[9px] font-black text-stone-400 uppercase">Giọng văn</label>
              <select value={params.tone} onChange={e => updateDraftParams(prev => ({...prev, tone: e.target.value as StoryParams['tone']}))} className="w-full p-2 bg-stone-50 border border-stone-200 rounded-lg text-[10px] font-bold outline-none">
                {TONES.map(tone => <option key={tone} value={tone}>{tone}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[9px] font-black text-stone-400 uppercase">Kết cấu</label>
              <select value={params.mode} onChange={e => updateDraftParams(prev => ({...prev, mode: e.target.value as StoryParams['mode']}))} className="w-full p-2 bg-stone-50 border border-stone-200 rounded-lg text-[10px] font-bold outline-none">
                {MODES.map(mode => <option key={mode} value={mode}>{mode}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[9px] font-black text-stone-400 uppercase">Ngôi kể / Điểm nhìn</label>
            <select value={params.narrativeView || 'Ngôi thứ ba hạn chế bám nhân vật chính'} onChange={e => updateDraftParams(prev => ({...prev, narrativeView: e.target.value}))} className="w-full p-2 bg-stone-50 border border-stone-200 rounded-lg text-[10px] font-bold outline-none">
              {['Ngôi thứ ba hạn chế bám nhân vật chính', 'Ngôi thứ nhất (nhân vật chính kể)', 'Ngôi thứ ba toàn tri', 'Đa điểm nhìn (ghi rõ trong bản đồ chương)'].map(viewOption => <option key={viewOption} value={viewOption}>{viewOption}</option>)}
            </select>
          </div>

          <div className={`grid ${params.projectType === 'Trường Thiên' ? 'grid-cols-2' : 'grid-cols-1'} gap-3`}>
            {params.projectType === 'Trường Thiên' && (
              <div className="space-y-1">
                <label className="text-[9px] font-black text-stone-400 uppercase">Số chương</label>
                <input type="number" min={MIN_TOTAL_CHAPTERS} max={MAX_TOTAL_CHAPTERS} value={params.totalChapters} onChange={e => updateDraftParams(prev => ({...prev, totalChapters: parseInt(e.target.value) || 1}))} className="w-full p-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-bold focus:ring-1 focus:ring-amber-300 outline-none" />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[9px] font-black text-stone-400 uppercase">{params.projectType === 'Trường Thiên' ? 'Số chữ/Chương' : 'Số chữ truyện'}</label>
              <input type="number" min={MIN_CHAPTER_WORDS} max={MAX_CHAPTER_WORDS} step={100} value={params.length} onChange={e => updateDraftParams(prev => ({...prev, length: parseInt(e.target.value) || 500}))} className="w-full p-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-bold focus:ring-1 focus:ring-amber-300 outline-none" />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[9px] font-black text-stone-400 uppercase">Nhân vật chính</label>
            <input type="text" value={params.character.name} onChange={e => updateDraftParams(prev => ({...prev, character: {...prev.character, name: e.target.value}}))} className="w-full p-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-bold" placeholder="Tên..." />
            <textarea value={params.character.personality} onChange={e => updateDraftParams(prev => ({...prev, character: {...prev.character, personality: e.target.value}}))} className="w-full p-2 bg-stone-50 border border-stone-200 rounded-lg text-[10px] h-16" placeholder="Tính cách..." />
            <textarea value={params.character.goal} onChange={e => updateDraftParams(prev => ({...prev, character: {...prev.character, goal: e.target.value}}))} className="w-full p-2 bg-stone-50 border border-stone-200 rounded-lg text-[10px] h-14" placeholder="Mục tiêu, nỗi sợ, vết thương lòng..." />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-black text-stone-400 uppercase">Thể loại</label>
            <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto p-2 border border-[#d8c491] rounded-xl bg-[#fffaf0]/70 custom-scrollbar">
              {GENRES.map(g => (
                <button key={g} onClick={() => toggleGenre(g)} className={`px-2 py-1 text-[9px] rounded-md border transition-all ${params.genres.includes(g) ? 'bg-[#07503f] text-amber-200 border-[#07503f] shadow-md' : 'bg-[#fffdf6]/80 text-stone-600 border-[#d8c491] hover:border-amber-500 hover:text-[#7c5a10]'}`}>{g}</button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-black text-stone-400 uppercase">Ý tưởng khởi nguồn</label>
            <textarea value={params.seed} onChange={e => updateDraftParams(prev => ({...prev, seed: e.target.value}))} className="w-full h-24 p-3 text-xs bg-stone-50 border border-stone-200 rounded-xl outline-none resize-none font-medium focus:ring-1 focus:ring-amber-300" placeholder="Nhập khởi nguồn..." />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-black text-stone-400 uppercase">Truyện mẫu / lưu ý văn phong</label>
            <textarea value={params.referenceStories} onChange={e => updateDraftParams(prev => ({...prev, referenceStories: e.target.value}))} className="w-full h-20 p-3 text-xs bg-stone-50 border border-stone-200 rounded-xl outline-none resize-none font-medium focus:ring-1 focus:ring-amber-300" placeholder="Ví dụ: nhịp chậm, ít giải thích, nhiều đối thoại, không copy tình tiết..." />
          </div>
          <button onClick={handleStartProject} disabled={isGeneratingOutline} className="btn-primary w-full py-4 font-black text-[10px] uppercase disabled:opacity-50">
            {isGeneratingOutline ? 'Đang xử lý...' : (params.projectType === 'Truyện Ngắn' ? 'Viết truyện ngắn' : 'Chọn hướng truyện')}
          </button>
        </div>
        <button onClick={() => setView('my-stories')} className="mt-auto py-3 px-4 bg-stone-50 rounded-lg border border-stone-200 text-[10px] font-black uppercase text-stone-500 hover:bg-amber-50 hover:text-orange-600 transition-all flex items-center justify-between">
          <span>Tàng thư ({projects.length})</span>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
        </button>
        {activeProject && (
          <div className="p-4 bg-stone-950 text-white rounded-lg shadow-sm space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-[8px] font-black uppercase text-orange-200 tracking-widest">Đang mở</span>
                <span className="block text-xs font-black truncate">{activeProject.title}</span>
              </div>
              <span className="text-[10px] font-black">{progressPercent}%</span>
            </div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-orange-300 rounded-full transition-all" style={{ width: `${Math.min(100, progressPercent)}%` }} />
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
            <button onClick={() => setView('outline')} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'outline' ? 'border-orange-600 text-orange-600' : 'border-transparent text-stone-300 hover:text-stone-500'}`}>Lộ trình Arc</button>
            <button onClick={() => setView('manuscript')} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'manuscript' ? 'border-orange-600 text-orange-600' : 'border-transparent text-stone-300 hover:text-stone-500'}`}>Bản thảo ({writtenChapters.length})</button>
            <button onClick={() => setView('bible')} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'bible' ? 'border-orange-600 text-orange-600' : 'border-transparent text-stone-300 hover:text-stone-500'}`}>Thiên Cơ Lục</button>
            <button onClick={openEditorWithGuard} className={`text-[10px] font-black uppercase tracking-widest h-full border-b-2 transition-all shrink-0 ${view === 'editor' ? 'border-orange-600 text-orange-600' : 'border-transparent text-stone-300 hover:text-stone-500'}`}>Chấp bút</button>
            <button onClick={handleReviewStoryLogic} disabled={isCheckingLogic || writtenChapters.length === 0} className="ml-auto px-4 py-2 bg-[#07503f] text-amber-200 rounded-full text-[9px] font-black uppercase tracking-widest disabled:opacity-40 hover:bg-[#0a6a54] hover:text-amber-100 transition-all shrink-0">
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
                      <span className="inline-flex px-2.5 py-1 bg-[#07503f] text-amber-200 rounded-md text-[9px] font-black uppercase tracking-widest border border-amber-200/40 shadow-sm">Studio sáng tác</span>
                      <span className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">Quy trình khóa logic</span>
                    </div>
                    <h2 className="text-3xl md:text-4xl font-black text-stone-950 story-font leading-tight">
                      Xưởng dựng truyện Bút Nghiên AI
                    </h2>
                    <p className="mt-3 text-sm md:text-base text-stone-600 leading-7">
                      Nhập hồ sơ ở bảng điều khiển bên trái. Hệ thống sẽ đề xuất nhiều chiến lược phát triển truyện, sau đó khóa Đại cục, Arc và Thiên Cơ Lục trước khi mở bước viết chương.
                    </p>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3 shrink-0">
                    <button onClick={handleStartProject} disabled={isGeneratingOutline} className="btn-primary px-6 py-3 text-[10px] font-black uppercase tracking-widest disabled:opacity-50">
                      {isGeneratingOutline ? 'Đang dựng dự án...' : (params.projectType === 'Truyện Ngắn' ? 'Viết truyện ngắn' : 'Chọn hướng truyện')}
                    </button>
                    <button onClick={() => setView('my-stories')} className="btn-secondary px-6 py-3 text-[10px] font-black uppercase tracking-widest">
                      Mở Tàng Thư
                    </button>
                  </div>
                </div>
              </section>

              <section className="grid xl:grid-cols-[1fr_380px] gap-5 items-start">
                <div className="space-y-5">
                  <div className="grid sm:grid-cols-3 gap-3">
                    <div className="surface-muted p-4">
                      <span className="block text-[8px] font-black uppercase text-[#96762a] tracking-widest">Dự án</span>
                      <strong className="block mt-2 text-base 2xl:text-lg font-black text-stone-950 whitespace-nowrap">{params.projectType}</strong>
                    </div>
                    <div className="surface-muted p-4 border-amber-200 bg-amber-50/80">
                      <span className="block text-[8px] font-black uppercase text-amber-700 tracking-widest">Lộ trình</span>
                      <strong className="block mt-2 text-base 2xl:text-lg font-black text-amber-950 whitespace-nowrap">{params.projectType === 'Trường Thiên' ? `${params.totalChapters} chương` : 'Truyện đơn'}</strong>
                    </div>
                    <div className="surface-muted p-4 border-orange-200 bg-amber-50/80">
                      <span className="block text-[8px] font-black uppercase text-orange-600 tracking-widest">Mục tiêu</span>
                      <strong className="block mt-2 text-base 2xl:text-lg font-black text-stone-950 whitespace-nowrap">{params.length} chữ</strong>
                    </div>
                  </div>

                  <div className="surface p-5">
                    <div className="flex items-center justify-between gap-4 mb-4">
                      <div>
                        <h3 className="text-xs font-black uppercase tracking-widest text-stone-900">Hồ sơ đầu vào</h3>
                        <p className="text-xs text-stone-500 mt-1">Những khóa chính AI đang dùng để dựng truyện.</p>
                      </div>
                      <span className={`px-2.5 py-1 rounded-md text-[9px] font-black uppercase ${planCompletenessPercent > 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-stone-100 text-stone-500 border border-stone-200'}`}>
                        {planCompletenessPercent}% sẵn sàng
                      </span>
                    </div>
                    <div className="grid md:grid-cols-2 gap-3">
                      <div className="surface-muted p-4">
                        <span className="text-[8px] font-black uppercase tracking-widest text-[#96762a]">Nhân vật</span>
                        <p className="mt-2 text-sm font-black text-stone-900">{params.character.name || 'Chưa đặt tên'}</p>
                        <p className="mt-1 text-xs text-stone-500 line-clamp-2">{params.character.personality || 'Chưa có tính cách khóa.'}</p>
                      </div>
                      <div className="surface-muted p-4">
                        <span className="text-[8px] font-black uppercase tracking-widest text-[#96762a]">Mục tiêu nhân vật</span>
                        <p className="mt-2 text-xs text-stone-600 line-clamp-4">{params.character.goal || 'Chưa có mục tiêu hoặc vết thương lòng.'}</p>
                      </div>
                      <div className="surface-muted p-4">
                        <span className="text-[8px] font-black uppercase tracking-widest text-[#96762a]">Thể loại</span>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {params.genres.slice(0, 6).map(genre => (
                            <span key={genre} className="px-2 py-1 rounded-md bg-white border border-stone-200 text-[9px] font-bold text-stone-600">{genre}</span>
                          ))}
                        </div>
                      </div>
                      <div className="surface-muted p-4">
                        <span className="text-[8px] font-black uppercase tracking-widest text-[#96762a]">Văn phong</span>
                        <p className="mt-2 text-xs text-stone-600 line-clamp-4">{params.referenceStories || params.tone}</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-[#052e26]/85 backdrop-blur-xl border border-amber-200/20 text-white rounded-lg p-5 shadow-lg shadow-teal-950/30 space-y-5">
                  <div>
                    <span className="text-[9px] font-black uppercase text-emerald-300 tracking-widest">Luồng bắt buộc</span>
                    <h3 className="text-xl font-black story-font mt-2">Không chấp bút khi chưa khóa khung truyện</h3>
                  </div>
                  <div className="space-y-3">
                    {workflowSteps.map((step, idx) => (
                      <div key={step.label} className="grid grid-cols-[36px_1fr] gap-3 items-start">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-black ${step.status === 'done' ? 'bg-emerald-400 text-stone-950' : step.status === 'active' ? 'bg-amber-300 text-stone-950' : 'bg-white/10 text-stone-400'}`}>
                          {idx + 1}
                        </div>
                        <div className="pt-0.5">
                          <p className="text-sm font-black">{step.label}</p>
                          <p className="text-[10px] text-stone-400">{step.status === 'done' ? 'Đã sẵn sàng' : step.status === 'active' ? 'Đang cần hoàn thiện' : 'Chờ bước trước'}</p>
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

          {view === 'directions' && (
            <div className="max-w-7xl mx-auto py-6 md:py-8 space-y-5 animate-in fade-in">
              <section className="surface p-5 md:p-6">
                <div className="grid lg:grid-cols-[1fr_360px] gap-5 items-stretch">
                  <div className="max-w-3xl">
                    <div className="flex flex-wrap items-center gap-2 mb-4">
                      <span className="inline-flex px-2.5 py-1 bg-amber-50 text-orange-700 rounded-md text-[9px] font-black uppercase tracking-widest border border-amber-100">Bàn biên tập chiến lược</span>
                      <span className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">{visibleDirectionChoices.length} hướng phát triển</span>
                    </div>
                    <h2 className="text-3xl md:text-4xl font-black text-stone-950 leading-tight">
                      Chọn hướng đi trước khi khóa lộ trình Arc
                    </h2>
                    <p className="mt-3 text-sm md:text-base text-stone-600 leading-7">
                      Key 6 đọc toàn bộ cấu hình ở cột trái rồi tạo 10 hướng truyện riêng. Mỗi lựa chọn là một chiến lược sáng tác khác nhau: động cơ truyện, nhịp Arc, kiểu cao trào và lỗi cần tránh. Chọn một hướng để khóa nó vào hồ sơ trước khi AI dựng Đại cục.
                    </p>
                    <div className="mt-5 grid sm:grid-cols-3 gap-3">
                      <div className="surface-muted p-3 bg-white">
                        <span className="block text-[8px] font-black uppercase tracking-widest text-[#96762a]">Tư duy Arc</span>
                        <p className="mt-1 text-xs font-bold text-stone-700">Dài/ngắn theo trọng lượng tình tiết.</p>
                      </div>
                      <div className="surface-muted p-3 bg-white">
                        <span className="block text-[8px] font-black uppercase tracking-widest text-[#96762a]">Khóa canon</span>
                        <p className="mt-1 text-xs font-bold text-stone-700">Mỗi lựa chọn sinh Thiên Cơ Lục riêng.</p>
                      </div>
                      <div className="surface-muted p-3 bg-white">
                        <span className="block text-[8px] font-black uppercase tracking-widest text-[#96762a]">Văn phong</span>
                        <p className="mt-1 text-xs font-bold text-stone-700">Hiện đại, gọn, rõ cảnh, ít sáo ngữ.</p>
                      </div>
                    </div>
                  </div>
                  <div className="bg-stone-950 text-white rounded-lg p-5 flex flex-col justify-between gap-5">
                    <div>
                      <span className="inline-flex px-2 py-1 bg-white/10 text-amber-100 rounded-md text-[8px] font-black uppercase tracking-widest">Đang xem</span>
                      <h3 className="mt-3 text-xl font-black leading-tight">{selectedDirection?.title || 'Chưa chọn hướng'}</h3>
                      <p className="mt-3 text-xs leading-6 text-stone-300">{selectedDirection?.engine || 'Di chuột hoặc chạm vào một thẻ để xem động cơ truyện.'}</p>
                    </div>
                    <div className="space-y-3">
                      <div className="p-3 bg-white/10 border border-white/10 rounded-lg">
                        <p className="text-[8px] font-black uppercase tracking-widest text-emerald-200">Phù hợp</p>
                        <p className="mt-1 text-xs leading-5 text-stone-200">{selectedDirection?.bestFor || 'Key 6 sẽ tạo hướng truyện từ hồ sơ bạn nhập.'}</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => setView('setup')} className="flex-1 px-4 py-3 bg-white/10 hover:bg-white/20 rounded-lg text-[9px] font-black uppercase tracking-widest">
                          Sửa hồ sơ
                        </button>
                        {selectedDirection && (
                          <button onClick={() => handleChooseDirection(selectedDirection)} disabled={isGeneratingOutline} className="flex-1 px-4 py-3 bg-orange-500 hover:bg-orange-400 text-white rounded-lg text-[9px] font-black uppercase tracking-widest disabled:opacity-60">
                            Khóa hướng
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
                {visibleDirectionChoices.map(choice => (
                  <button
                    key={choice.id}
                    onMouseEnter={() => setSelectedDirectionId(choice.id)}
                    onFocus={() => setSelectedDirectionId(choice.id)}
                    onClick={() => handleChooseDirection(choice)}
                    disabled={isGeneratingOutline}
                    className={`surface text-left p-5 transition-all hover:-translate-y-0.5 hover:border-orange-200 disabled:opacity-60 ${selectedDirectionId === choice.id ? 'ring-2 ring-orange-200 border-orange-200 bg-amber-50/40' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <span className="inline-flex px-2 py-1 bg-white border border-stone-200 rounded-md text-[8px] font-black uppercase tracking-widest text-stone-500">{choice.badge}</span>
                        <h3 className="mt-3 text-lg font-black text-stone-950">{choice.title}</h3>
                      </div>
                      <span className="w-8 h-8 rounded-lg bg-stone-950 text-white flex items-center justify-center text-xs font-black shrink-0">
                        {selectedDirectionId === choice.id ? '✓' : '→'}
                      </span>
                    </div>
                    <div className="mt-4 space-y-3">
                      <div>
                        <p className="text-[8px] font-black uppercase tracking-widest text-[#96762a]">Động cơ truyện</p>
                        <p className="mt-1 text-xs leading-5 text-stone-700">{choice.engine}</p>
                      </div>
                      <div>
                        <p className="text-[8px] font-black uppercase tracking-widest text-[#96762a]">Tiền đề</p>
                        <p className="mt-1 text-sm leading-6 text-stone-700">{choice.premise}</p>
                      </div>
                      <div>
                        <p className="text-[8px] font-black uppercase tracking-widest text-[#96762a]">Logic cốt truyện</p>
                        <p className="mt-1 text-xs leading-5 text-stone-600">{choice.logic}</p>
                      </div>
                      <div className="grid grid-cols-1 gap-2">
                        <div className="p-3 bg-stone-50 border border-stone-100 rounded-md">
                          <p className="text-[8px] font-black uppercase tracking-widest text-orange-500">Nhịp Arc</p>
                          <p className="mt-1 text-[11px] leading-5 text-stone-600">{choice.arcBias}</p>
                        </div>
                        <div className="p-3 bg-amber-50 border border-amber-100 rounded-md">
                          <p className="text-[8px] font-black uppercase tracking-widest text-amber-700">Chặn lỗi logic</p>
                          <p className="mt-1 text-[11px] leading-5 text-amber-900">{choice.risk}</p>
                        </div>
                        <div className="p-3 bg-emerald-50 border border-emerald-100 rounded-md">
                          <p className="text-[8px] font-black uppercase tracking-widest text-emerald-700">Cao trào phù hợp</p>
                          <p className="mt-1 text-[11px] leading-5 text-emerald-900">{choice.payoff}</p>
                        </div>
                      </div>
                    </div>
                    <div className="mt-5 flex items-center justify-between border-t border-stone-100 pt-4">
                      <span className="text-[10px] font-black uppercase tracking-widest text-orange-700">Khóa hướng này</span>
                      <span className="text-[10px] font-black uppercase text-stone-400">Lập Arc</span>
                    </div>
                  </button>
                ))}
              </section>
            </div>
          )}

          {view === 'outline' && (
            <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in pb-20">
              <section className="p-6 bg-white border rounded-3xl shadow-sm border-l-4 border-l-orange-600">
                <h3 className="text-[10px] font-black text-orange-600 uppercase mb-2">Đại cục Trường Thiên</h3>
                <div className="space-y-4">{renderOutlineText(generalSummary)}</div>
              </section>
              <section className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div className="p-4 bg-white border border-stone-100 rounded-2xl shadow-sm">
                  <span className="block text-[8px] font-black uppercase text-[#96762a] tracking-widest">Số chương</span>
                  <strong className="text-2xl font-black text-stone-900">{plannedChapterIndexes.size}/{params.totalChapters}</strong>
                </div>
                <div className="p-4 bg-white border border-stone-100 rounded-2xl shadow-sm">
                  <span className="block text-[8px] font-black uppercase text-[#96762a] tracking-widest">Arc</span>
                  <strong className="text-2xl font-black text-stone-900">{volumes.length}</strong>
                </div>
                <div className="p-4 bg-white border border-stone-100 rounded-2xl shadow-sm">
                  <span className="block text-[8px] font-black uppercase text-[#96762a] tracking-widest">Canon</span>
                  <strong className={`text-2xl font-black ${canonReadyCount === canonChecklist.length ? 'text-emerald-600' : 'text-amber-600'}`}>{canonReadyCount}/{canonChecklist.length}</strong>
                </div>
                <div className="p-4 bg-white border border-stone-100 rounded-2xl shadow-sm">
                  <span className="block text-[8px] font-black uppercase text-[#96762a] tracking-widest">Trạng thái</span>
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
                    <p className="text-sm text-stone-700 mt-1">
                      {hasRoadmapReady
                        ? `Đã khóa bản đồ chi tiết cho ${plannedChapterIndexes.size}/${params.totalChapters} chương trong ${volumes.length} Arc.${missingChapterIndexes.length > 0 ? ` ${missingChapterIndexes.length} chương còn lại sẽ được lập bản đồ tự động khi bắt đầu viết Arc tương ứng.` : ''}${fallbackPlanCount > 0 ? ` Có ${fallbackPlanCount} kế hoạch đang là mẫu tự lấp do AI trả thiếu — sẽ được lập lại khi viết tới Arc tương ứng.` : ''} Chương kế tiếp nên viết: ${(firstUnwrittenChapterIndex || firstUnwrittenPlan) ? `C.${firstUnwrittenChapterIndex || firstUnwrittenPlan?.index}${firstUnwrittenPlan ? ` - ${firstUnwrittenPlan.title}` : ''}` : 'lộ trình đã hoàn tất'}.`
                        : roadmapIssues.join(' ')}
                    </p>
                  </div>
                  <button onClick={openEditorWithGuard} disabled={!hasRoadmapReady || !(firstUnwrittenChapterIndex || firstUnwrittenPlan)} className="px-6 py-3 bg-stone-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-stone-900 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                    {(firstUnwrittenChapterIndex || firstUnwrittenPlan) ? 'Viết chương kế tiếp' : 'Đã đủ bản thảo'}
                  </button>
                </div>
              </section>
              <section className="p-6 bg-white border rounded-3xl shadow-sm border-l-4 border-l-stone-900">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
                  <h3 className="text-[10px] font-black text-stone-900 uppercase tracking-widest">Thiên Cơ Lục khởi tạo</h3>
                  <button onClick={() => setView('bible')} className="px-4 py-2 bg-stone-900 text-white rounded-xl text-[9px] font-black uppercase hover:bg-stone-900 transition-all">
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
                <p className="story-font text-base text-stone-700 leading-relaxed whitespace-pre-wrap line-clamp-4">{worldBible || 'Thiên Cơ Lục sẽ xuất hiện sau khi lập lộ trình Arc.'}</p>
              </section>
              <div className="grid grid-cols-1 gap-8">
                {volumes && volumes.map((vol) => {
                  const arcSynopsis = getArcSynopsisState(vol);
                  return (
                  <div key={`vol-${vol.index}`} className="space-y-4">
                    <div className="bg-white p-6 rounded-3xl border shadow-sm border-t-4 border-t-amber-100 flex flex-col gap-4">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-stone-900 text-white rounded-xl flex items-center justify-center font-bold shadow-lg">{vol.index}</div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-black text-stone-900 story-font text-xl uppercase tracking-tight">{getArcDisplayTitle(vol)}</h3>
                            {vol.chapterStart && vol.chapterEnd && (
                              <>
                                <span className="px-2 py-1 bg-stone-100 text-stone-400 rounded-md text-[8px] font-black uppercase">C.{vol.chapterStart}-{vol.chapterEnd}</span>
                                <span className="px-2 py-1 bg-amber-50 text-amber-700 border border-amber-100 rounded-md text-[8px] font-black uppercase">{Math.max(1, vol.chapterEnd - vol.chapterStart + 1)} chương</span>
                              </>
                            )}
                          </div>
                          <div className="mt-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="block text-[8px] font-black uppercase tracking-widest text-[#96762a]">Nội dung Arc bắt buộc</span>
                              <span className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase border ${arcSynopsis.isFallback ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-emerald-50 text-emerald-700 border-emerald-100'}`}>
                                {arcSynopsis.isFallback ? 'Bản dự phòng' : 'Đã khóa'}
                              </span>
                            </div>
                            <p className={`mt-2 rounded-2xl border px-4 py-3 text-[13px] leading-relaxed font-medium ${arcSynopsis.isFallback ? 'border-amber-100 bg-amber-50/70 text-amber-900' : 'border-stone-100 bg-stone-50/80 text-stone-600'}`}>
                              {arcSynopsis.text}
                            </p>
                            {arcSynopsis.isFallback && (
                              <p className="mt-2 text-[10px] leading-relaxed text-amber-700 font-semibold">
                                AI chưa tạo được nội dung Arc đủ cụ thể; hãy lập lại lộ trình trước khi viết chương để tránh chương bị chung chung.
                              </p>
                            )}
                          </div>
                          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                            <div className="rounded-2xl bg-stone-50 border border-stone-100 p-3">
                              <span className="block text-[8px] font-black uppercase tracking-widest text-[#96762a]">Chủ đề Arc</span>
                              <p className="mt-1 text-[11px] leading-relaxed text-stone-600 font-semibold">{getArcTheme(vol)}</p>
                            </div>
                            <div className="rounded-2xl bg-amber-50/60 border border-amber-100 p-3">
                              <span className="block text-[8px] font-black uppercase tracking-widest text-orange-400">Mục tiêu sơ bộ</span>
                              <p className="mt-1 text-[11px] leading-relaxed text-orange-700 font-semibold">{getArcObjective(vol)}</p>
                            </div>
                          </div>
                          {vol.purpose && (
                            <div className="mt-2">
                              <span className="block text-[8px] font-black uppercase tracking-widest text-[#96762a]">Vai trò Arc</span>
                              <p className="text-[10px] text-orange-500 font-bold mt-1 uppercase tracking-widest">{vol.purpose}</p>
                            </div>
                          )}
                        </div>
                      </div>
                      
                      {vol.chapters && vol.chapters.length > 0 && (
                        <div className="space-y-2 mt-4">
                          <h4 className="text-[9px] font-black uppercase text-stone-400 border-b pb-1">Bản đồ chương thuộc Arc này</h4>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {sortChapters(vol.chapters).map(chap => (
                              <div key={chap.index} className="p-4 bg-stone-50 border border-stone-100 rounded-2xl flex flex-col gap-3 group hover:border-orange-200 transition-all shadow-sm">
                                <div>
                                  <span className="text-xs font-bold text-stone-700 line-clamp-1">C.{chap.index}: {chap.title}</span>
                                  <p className="text-[10px] text-stone-400 mt-1 line-clamp-2">{chap.objective || chap.summary}</p>
                                  <div className="flex gap-1 mt-2">
                                    <span className="px-2 py-0.5 bg-white rounded-md text-[8px] font-black text-stone-400 border">{chap.targetWords || params.length} chữ</span>
                                    <span className="px-2 py-0.5 bg-white rounded-md text-[8px] font-black text-stone-400 border">{chap.pacing || 'Nhịp vừa'}</span>
                                    {chap.biblePending && <span className="px-2 py-0.5 bg-amber-100 rounded-md text-[8px] font-black text-amber-700 border border-amber-200">⚠ Canon chờ cập nhật</span>}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  {chap.content ? (
                                    <>
                                      <button onClick={() => handleReadChapter(chap, vol.index)} className="flex-1 py-1.5 bg-amber-50 text-orange-600 rounded-lg text-[9px] font-black uppercase hover:bg-orange-600 hover:text-white transition-all">Đọc</button>
                                      <button onClick={() => void handleListenChapter(chap)} className="flex-1 py-1.5 bg-teal-50 text-teal-700 rounded-lg text-[9px] font-black uppercase hover:bg-teal-600 hover:text-white transition-all">Nghe</button>
                                      <button onClick={() => handleRewriteChapter(chap, vol.index)} className="flex-1 py-1.5 bg-stone-100 text-stone-600 rounded-lg text-[9px] font-black uppercase hover:bg-stone-800 hover:text-white transition-all">Viết lại</button>
                                      <button onClick={(e) => handleDeleteChapter(chap.index, vol.index, e)} className="p-1.5 bg-red-50 text-red-400 rounded-lg hover:bg-red-600 hover:text-white transition-all">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                      </button>
                                    </>
                                  ) : (
                                    <button onClick={() => { if (!hasRoadmapReady) { alert('Chưa có đủ Thiên Cơ Lục và lộ trình Arc. Hãy lập lộ trình trước khi viết.'); return; } setActiveArcIndex(vol.index); setCurrentChapterIndex(chap.index); setChapterIdea(''); setStory(''); setView('editor'); }} className="flex-1 py-1.5 bg-stone-900 text-white rounded-lg text-[9px] font-black uppercase hover:bg-black transition-all">Viết chương</button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <button 
                        onClick={() => handlePrepareWriteChapter(vol.index)}
                        className="w-full py-4 bg-amber-50 text-orange-600 rounded-xl font-black uppercase text-[10px] tracking-widest hover:bg-stone-900 hover:text-white transition-all flex items-center justify-center gap-2 mt-2 shadow-sm"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
                        Viết chương theo lộ trình này
                      </button>
                    </div>
                  </div>
                  );
                })}
                
                <button onClick={handleAddNextArc} disabled={isGeneratingOutline} className="w-full py-8 bg-stone-50 border-2 border-dashed border-stone-200 text-stone-400 rounded-3xl font-black uppercase text-[10px] tracking-widest hover:bg-amber-50 hover:text-orange-600 hover:border-orange-300 transition-all flex flex-col items-center gap-3 shadow-inner">
                  {isGeneratingOutline ? (generationStatus || 'Đang lập Arc mới...') : (
                    <>
                      <div className="w-10 h-10 bg-white border border-stone-100 rounded-full flex items-center justify-center shadow-sm">
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
              <section className="p-6 md:p-8 bg-[#052e26]/85 backdrop-blur-xl border border-amber-200/20 text-white rounded-3xl shadow-xl flex flex-col md:flex-row md:justify-between md:items-center gap-4">
                <h2 className="text-2xl font-black italic story-font">Tàng Thư Của Bạn</h2>
                <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
                  <button onClick={() => fileInputRef.current?.click()} className="bg-gradient-to-b from-amber-200 to-amber-400 text-stone-900 px-8 py-3 rounded-xl text-[10px] font-black uppercase shadow-lg shadow-amber-500/20 hover:brightness-110 transition-all">Nhập file (.json)</button>
                  <button onClick={handleExportLibraryBackup} className="bg-white/10 text-white px-8 py-3 rounded-xl text-[10px] font-black uppercase hover:bg-white/20 transition-all">Sao lưu toàn bộ (.json)</button>
                </div>
                <input type="file" ref={fileInputRef} onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    try {
                      const imported = JSON.parse(ev.target?.result as string);
                      if (imported && imported.kind === 'library-backup' && Array.isArray(imported.projects)) {
                        const validProjects = imported.projects.filter(isStoryProject).map(normalizeProjectRecord);
                        if (!validProjects.length) throw new Error('File sao lưu không có tác phẩm hợp lệ.');
                        validProjects.forEach(importedProject => {
                          if (tombstonesRef.current[importedProject.id]) {
                            delete tombstonesRef.current[importedProject.id];
                            clearLocalTombstone(importedProject.id);
                            void clearDeletedProjectOnFirebase(importedProject.id).catch(() => undefined);
                          }
                        });
                        setProjects(prev => {
                          const byId: Map<string, StoryProject> = new Map(prev.map(project => [project.id, project]));
                          validProjects.forEach(importedProject => {
                            const existing = byId.get(importedProject.id);
                            if (!existing || (importedProject.updatedAt || 0) >= (existing.updatedAt || 0)) byId.set(importedProject.id, importedProject);
                          });
                          return [...byId.values()].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
                        });
                        alert(`Đã nhập ${validProjects.length} tác phẩm từ file sao lưu — hệ thống sẽ tự lưu và đồng bộ.`);
                        return;
                      }
                      if (!isStoryProject(imported)) throw new Error('Không phải file dự án Bút Nghiên.');
                      const normalizedImport = normalizeProjectRecord(imported);
                      if (tombstonesRef.current[normalizedImport.id]) {
                        delete tombstonesRef.current[normalizedImport.id];
                        clearLocalTombstone(normalizedImport.id);
                        void clearDeletedProjectOnFirebase(normalizedImport.id).catch(() => undefined);
                      }
                      setProjects(prev => {
                          const existing = prev.find(p => p.id === normalizedImport.id);
                          if (existing) {
                              const fileIsOlder = (normalizedImport.updatedAt || 0) < (existing.updatedAt || 0);
                              const overwrite = window.confirm(fileIsOlder
                                ? 'File nhập CŨ HƠN bản đang có cùng mã dự án. Ghi đè bằng bản cũ hơn?'
                                : 'Đã có tác phẩm cùng mã dự án. Ghi đè bằng file nhập?');
                              if (!overwrite) {
                                const copy = { ...normalizedImport, id: crypto.randomUUID(), title: `${normalizedImport.title} (bản nhập)` };
                                setTimeout(() => setProjects(current => [copy, ...current]), 0);
                                return prev;
                              }
                              return prev.map(p => p.id === normalizedImport.id ? normalizedImport : p);
                          }
                          return [normalizedImport, ...prev];
                      });
                      alert("Đã nhập tác phẩm — hệ thống sẽ tự lưu và đồng bộ.");
                    } catch(e) { alert("File JSON không hợp lệ."); }
                  };
                  reader.readAsText(file);
                }} accept=".json" className="hidden" />
              </section>
              {projects.length === 0 && (
                <div className="surface p-10 text-center space-y-4">
                  <img src="/img/emblem-trim.webp" alt="Bút và nghiên mực" className="w-20 h-20 mx-auto rounded-3xl object-cover ring-1 ring-amber-300/60 shadow-lg shadow-teal-950/25" />
                  <p className="story-font text-2xl font-black text-stone-900">Tàng Thư đang trống</p>
                  <p className="text-sm text-stone-500 max-w-md mx-auto leading-relaxed">Chưa có tác phẩm nào được lưu. Quay lại Studio, khóa hồ sơ rồi chọn hướng truyện để chấp bút tác phẩm đầu tiên.</p>
                  <button onClick={() => setView('setup')} className="btn-primary px-6 py-3 text-[10px] font-black uppercase tracking-widest">Về Studio sáng tác</button>
                  <button onClick={handlePrefillSample} className="block mx-auto px-6 py-3 rounded-2xl border border-amber-300/70 text-amber-800 text-[10px] font-black uppercase tracking-widest hover:bg-amber-50 transition-all">Dùng hồ sơ mẫu thử</button>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {projects.map(p => (
                  <div key={p.id} className="surface cv-auto p-8 hover:shadow-2xl transition-all group flex flex-col h-80">
                    <div className="flex-1">
                      <div className="flex justify-between items-start mb-4">
                        <span className="px-3 py-1 bg-amber-50 text-orange-600 rounded-full text-[9px] font-black uppercase">{p.params.projectType}</span>
                        <div className="flex gap-2">
                           <button onClick={(e) => handleExportManuscript(p, e)} className="p-2 bg-emerald-50 text-emerald-500 rounded-lg hover:bg-emerald-600 hover:text-white transition-all shadow-sm" title="Xuất bản thảo TXT">
                             <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" /></svg>
                           </button>
                           <button onClick={(e) => { e.stopPropagation(); const latestProj = projects.find(proj => proj.id === p.id) || p; downloadTextFile(`ButNghien_${latestProj.title.replace(/\s+/g, '_')}.json`, JSON.stringify(latestProj, null, 2), 'application/json;charset=utf-8'); }} className="p-2 bg-amber-50 text-orange-400 rounded-lg hover:bg-orange-600 hover:text-white transition-all shadow-sm" title="Xuất JSON">
                             <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                           </button>
                           <button onClick={(e) => { e.stopPropagation(); loadProject(p); setView('player'); }} className="p-2 bg-teal-50 text-teal-500 rounded-lg hover:bg-teal-600 hover:text-white transition-all shadow-sm" title="Nghe & viết tự động">
                             <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" /></svg>
                           </button>
                           <button onClick={(e) => handleDuplicateProject(p, e)} className="p-2 bg-sky-50 text-sky-400 rounded-lg hover:bg-sky-600 hover:text-white transition-all shadow-sm" title="Nhân bản dự án">
                             <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H10a2 2 0 01-2-2V7z" /></svg>
                           </button>
                           <button onClick={(e) => handleDeleteProject(p.id, e)} className="p-2 bg-red-50 text-red-300 rounded-lg hover:bg-red-600 hover:text-white transition-all shadow-sm" title="Xóa dự án">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                           </button>
                        </div>
                      </div>
                      <h3 className="font-black text-xl uppercase text-stone-800 story-font group-hover:text-stone-900 mb-2 line-clamp-1">{p.title}</h3>
                      <p className="text-[10px] text-stone-400 italic line-clamp-4 leading-relaxed">{p.generalSummary}</p>
                      {(() => { const stats = projectQuickStats(p); return stats.chapterCount > 0 ? <p className="text-[10px] font-bold text-stone-500 mt-2">{stats.chapterCount} chương · {stats.totalWords.toLocaleString('vi-VN')} chữ</p> : null; })()}
                    </div>
                    <div className="flex gap-2 pt-6 border-t border-stone-50 mt-auto">
                      <button onClick={() => loadProject(p)} className="btn-primary flex-1 py-3 rounded-xl text-[10px] font-black uppercase">Mở dự án</button>
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
                  <h2 className="text-3xl font-black story-font text-stone-900">Cần hoàn thiện lộ trình trước</h2>
                  <div className="space-y-2">
                    {roadmapIssues.map(issue => (
                      <p key={issue} className="text-sm text-amber-800 font-bold">{issue}</p>
                    ))}
                  </div>
                  <button onClick={() => setView('outline')} className="px-7 py-3 bg-stone-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-stone-900 transition-all">
                    Về lộ trình Arc
                  </button>
                </section>
              ) : !story || isGenerating ? (
                <section className="p-6 md:p-10 bg-white border rounded-[2rem] md:rounded-[3rem] shadow-2xl space-y-8 border-t-[12px] border-t-stone-900 mt-6 md:mt-10 relative overflow-hidden">
                  <div className="text-center space-y-2">
                     <span className="text-[10px] font-black uppercase text-orange-600 tracking-[0.3em]">Thiên Cơ Lệnh</span>
                     <h3 className="text-2xl md:text-3xl font-black italic story-font text-stone-900">
                      Chương {currentChapterIndex} - {volumes.find(v => v.index === activeArcIndex)?.title}
                     </h3>
                     <p className="text-xs text-stone-400 italic">Mục tiêu Arc: {volumes.find(v => v.index === activeArcIndex)?.summary}</p>
                  </div>
                  {currentChapterPlan && (
                    <div className="p-5 bg-amber-50/70 border border-amber-100 rounded-2xl space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="text-xs font-black text-stone-900 uppercase">{currentChapterPlan.title}</h4>
                        <span className="px-3 py-1 bg-white text-orange-600 rounded-full text-[9px] font-black shadow-sm">{currentChapterPlan.targetWords || params.length} chữ</span>
                      </div>
                      <p className="text-xs text-orange-700 leading-relaxed">{currentChapterPlan.objective || currentChapterPlan.summary}</p>
                      {!!currentChapterPlan.beats?.length && (
                        <div className="flex flex-wrap gap-2">
                          {currentChapterPlan.beats?.map((beat, idx) => (
                            <span key={idx} className="px-2 py-1 bg-white/80 text-orange-500 rounded-md text-[9px] font-bold border border-amber-100">{beat}</span>
                          ))}
                        </div>
                      )}
                      {!!currentChapterPlan.mustInclude?.length && (
                        <div className="pt-2 border-t border-amber-100 flex flex-wrap gap-2">
                          {currentChapterPlan.mustInclude.map((item, idx) => (
                            <span key={idx} className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded-md text-[9px] font-bold border border-emerald-100">{item}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase text-stone-400 tracking-widest">Ý đồ của chương (AI sẽ ưu tiên bám lộ trình Arc)</label>
                    <textarea 
                      value={chapterIdea} 
                      onChange={e => setChapterIdea(e.target.value)} 
                      placeholder="Nhập yêu cầu nếu muốn điều chỉnh lộ trình..." 
                      className="w-full h-48 p-5 md:p-8 bg-stone-50 border border-stone-100 rounded-3xl text-sm outline-none resize-none font-medium focus:bg-white focus:ring-4 focus:ring-amber-50 transition-all shadow-inner" 
                    />
                  </div>
                  <button 
                    onClick={handleWriteChapter} 
                    disabled={isGenerating} 
                    className={`w-full py-6 rounded-full font-black uppercase text-xs shadow-2xl transition-all flex items-center justify-center gap-3 ${isGenerating ? 'bg-stone-200 text-stone-400 cursor-not-allowed' : 'bg-stone-900 text-white hover:bg-black'}`}
                  >
                    {isGenerating ? (generationStatus || 'Đang triệu hồi câu chữ...') : `Khai bút Chương ${currentChapterIndex}`}
                  </button>
                </section>
              ) : (
                <div className="space-y-12 animate-in fade-in zoom-in-95 duration-700">
                  <header className="text-center space-y-6">
                    <div className="flex flex-col items-center gap-3">
                      <div className="px-4 py-1.5 bg-amber-50 text-orange-600 rounded-full text-[10px] font-black uppercase tracking-[0.2em] shadow-sm">
                        Số chữ: {getWordCount(story)} / mục tiêu {getChapterPlan(currentChapterIndex)?.targetWords || params.length}
                      </div>
                      <h2 className="text-3xl md:text-5xl font-black italic story-font text-stone-900 leading-tight">
                        {writtenChapters.find(c => c.index === currentChapterIndex)?.title || `Chương ${currentChapterIndex}`}
                      </h2>
                    </div>
                    <div className="flex flex-wrap justify-center gap-4">
                      <button onClick={handleWriteNextChapter} className="text-[10px] font-black uppercase text-orange-600 bg-amber-50 px-8 py-3 rounded-full hover:bg-amber-100 transition-all shadow-sm">Viết Chương Tiếp Theo</button>
                      <button onClick={() => setView('outline')} className="text-[10px] font-black uppercase text-stone-400 border border-stone-200 px-8 py-3 rounded-full hover:bg-stone-50 transition-all">Về Lộ Trình</button>
                    </div>
                  </header>
                  {currentDraftIsPending && (
                    <section className="bg-white border border-amber-100 rounded-[2rem] shadow-xl p-5 md:p-6 space-y-4">
                      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                        <div>
                          <span className={`inline-flex px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border ${currentDraftIsAutosaved ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-amber-50 text-amber-700 border-amber-100'}`}>
                            {currentDraftIsAutosaved ? 'Đã lưu bản thảo chính' : 'Bản nháp Cụm 1'}
                          </span>
                          <h3 className="mt-3 text-lg font-black text-stone-900">
                            {draftReview ? 'Cụm 2 đã báo cáo, chờ tác giả quyết định' : currentDraftIsAutosaved ? 'Chương đã lưu, có thể thẩm định thêm' : 'Chưa gọi Cụm 2/3, chưa lưu vào bản thảo chính'}
                          </h3>
                          <p className="mt-1 text-xs text-stone-500 leading-5">
                            {currentDraftIsAutosaved
                              ? 'Chương này đã nằm trong Bản thảo/Tàng thư. Nếu cần biên tập, bấm Cụm 2 để nhận báo cáo lỗi; sau đó nhập yêu cầu thêm rồi mới gọi Cụm 3 viết lại.'
                              : 'Đọc bản nháp bên dưới. Nếu ổn, có thể lưu ngay. Nếu cần biên tập, bấm Cụm 2 để chỉ nhận báo cáo lỗi; sau đó nhập yêu cầu thêm rồi mới gọi Cụm 3 viết lại.'}
                          </p>
                        </div>
                        <button onClick={handleSaveCurrentDraft} disabled={isGenerating || currentDraftIsAutosaved} className="px-5 py-3 bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-2xl text-[10px] font-black uppercase hover:bg-emerald-600 hover:text-white transition-all disabled:opacity-50">
                          {currentDraftIsAutosaved ? 'Đã lưu' : 'Lưu bản này'}
                        </button>
                      </div>
                      <textarea
                        value={revisionRequest}
                        onChange={e => setRevisionRequest(e.target.value)}
                        placeholder="Yêu cầu thêm cho Cụm 3: ví dụ giảm lặp hình ảnh dòng sông, tăng đối thoại, sửa logic đặt tên, giữ nhịp chậm nhưng phải có biến chuyển rõ..."
                        className="w-full h-28 p-4 bg-stone-50 border border-stone-100 rounded-2xl text-sm outline-none resize-none focus:bg-white focus:ring-4 focus:ring-amber-50 transition-all"
                      />
                      {draftReview && (
                        <div className={`p-4 rounded-2xl border ${draftReview.isValid ? 'bg-emerald-50 border-emerald-100 text-emerald-900' : 'bg-amber-50 border-amber-100 text-amber-900'}`}>
                          <p className="text-[9px] font-black uppercase tracking-widest">{draftReview.unverified ? 'Cụm 2: chưa thẩm định được' : draftReview.isValid ? 'Cụm 2: đạt cơ bản' : 'Cụm 2: cần sửa'}</p>
                          <p className="mt-1 text-xs leading-5">{draftReview.reason}</p>
                          {draftReviewIssues.length > 0 && (
                            <ul className="mt-3 space-y-1 text-xs leading-5 list-disc pl-4">
                              {draftReviewIssues.slice(0, 8).map((issue, idx) => <li key={idx}>{issue}</li>)}
                            </ul>
                          )}
                          {draftReview.fixPlan && (
                            <p className="mt-3 text-xs leading-5 font-semibold">Kế hoạch sửa: {draftReview.fixPlan}</p>
                          )}
                        </div>
                      )}
                      {!draftReview ? (
                        <button onClick={handleReviewDraft} disabled={isGenerating} className="w-full py-4 bg-stone-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-black transition-all disabled:opacity-50">
                          {isGenerating ? (generationStatus || 'Đang xử lý...') : 'Cụm 2 thẩm định bản nháp'}
                        </button>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <button onClick={handleReviewDraft} disabled={isGenerating} className="w-full py-4 bg-amber-50 text-orange-700 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-amber-100 transition-all disabled:opacity-50">
                            {isGenerating ? (generationStatus || 'Đang xử lý...') : 'Thẩm định lại'}
                          </button>
                          <button onClick={handleRewriteReviewedDraft} disabled={isGenerating} className="w-full py-4 bg-stone-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-black transition-all disabled:opacity-50">
                            {isGenerating ? (generationStatus || 'Đang xử lý...') : 'Cụm 3 viết lại theo báo cáo'}
                          </button>
                        </div>
                      )}
                    </section>
                  )}
                  <article className="manuscript-reader story-font text-lg md:text-2xl text-stone-800 text-left shadow-2xl p-6 md:p-20 bg-white/95 rounded-[2rem] md:rounded-[3rem] border border-stone-50 relative">
                    {renderStoryParagraphs(story)}
                  </article>
                </div>
              )}
            </div>
          )}
          
          {view === 'bible' && (
             <div className="max-w-4xl mx-auto py-12 pb-32">
                <header className="mb-12 flex flex-col items-center gap-4">
                  <div className="w-16 h-16 bg-stone-900 text-white rounded-2xl flex items-center justify-center shadow-2xl rotate-3">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                  </div>
                  <h2 className="text-4xl font-black italic text-stone-900 story-font uppercase tracking-tighter">Thiên Cơ Lục</h2>
                  <p className="text-xs text-stone-400 uppercase font-black tracking-[0.4em]">Biên niên sử nhất quán với lộ trình</p>
                </header>
                {pendingBibleChapters.length > 0 && (
                  <section className="mb-10 bg-amber-50 border border-amber-200 rounded-3xl p-6 shadow-sm text-left">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-amber-700">⚠ Thiên Cơ Lục chưa cập nhật đầy đủ</h3>
                    <p className="text-sm text-stone-700 mt-2 leading-relaxed">
                      Đang thiếu dữ kiện của chương {pendingBibleChapters.map(c => c.index).join(', ')}.
                      {pendingBibleChapters[0].biblePendingReason ? <> Lý do gần nhất: {pendingBibleChapters[0].biblePendingReason}</> : null}
                      {' '}Các chương viết sau mốc này có thể lệch canon. Bấm cập nhật lại để hệ thống chạy lại từ chương thiếu đầu tiên — các chương sau đó cũng được chạy lại để giữ chuỗi Thiên Cơ Lục nhất quán.
                    </p>
                    <button onClick={handleRetryBibleUpdate} disabled={isRetryingBible || isGenerating} className="mt-4 px-5 py-2.5 bg-amber-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-amber-700 disabled:opacity-40 transition-all">
                      {isRetryingBible ? (generationStatus || 'Đang cập nhật lại...') : 'Cập nhật lại Thiên Cơ Lục'}
                    </button>
                  </section>
                )}
                {logicReport && (
                  <section className="mb-10 bg-white border border-amber-100 rounded-3xl p-8 shadow-sm space-y-6">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <h3 className="text-[10px] font-black text-orange-600 uppercase tracking-widest">Báo cáo logic truyện</h3>
                        <p className="story-font text-xl text-stone-800 mt-2 italic">{logicReport.summary}</p>
                      </div>
                      <div className="w-20 h-20 rounded-2xl bg-stone-900 text-white flex flex-col items-center justify-center shadow-xl">
                        <span className="text-2xl font-black">{logicReport.score}</span>
                        <span className="text-[8px] font-bold uppercase">/100</span>
                      </div>
                    </div>
                    {logicReport.issues.length > 0 && (
                      <div className="space-y-3">
                        {logicReport.issues.map((issue, idx) => (
                          <div key={idx} className="p-4 bg-stone-50 rounded-2xl border border-stone-100">
                            <div className="flex items-center gap-2 mb-2">
                              <span className={`px-2 py-1 rounded-md text-[8px] font-black uppercase ${issue.severity === 'Cao' ? 'bg-red-100 text-red-600' : issue.severity === 'Vừa' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{issue.severity}</span>
                              {issue.chapter && <span className="text-[9px] font-black uppercase text-stone-400">Chương {issue.chapter}</span>}
                            </div>
                            <p className="text-sm font-bold text-stone-700">{issue.issue}</p>
                            <p className="text-xs text-stone-500 mt-1">{issue.fix}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="p-4 bg-amber-50 rounded-2xl">
                        <h4 className="text-[9px] font-black uppercase text-orange-600 mb-2">Gợi ý biên tập</h4>
                        <ul className="space-y-2">
                          {logicReport.suggestions.map((suggestion, idx) => (
                            <li key={idx} className="text-xs text-stone-800 leading-relaxed">{suggestion}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="p-4 bg-stone-900 text-white rounded-2xl">
                        <h4 className="text-[9px] font-black uppercase text-orange-200 mb-2">Trọng tâm chương tiếp theo</h4>
                        <p className="text-sm story-font leading-relaxed">{logicReport.nextChapterFocus}</p>
                      </div>
                    </div>
                  </section>
                )}
                {renderBibleContent(worldBible)}
             </div>
          )}
          
          {view === 'player' && (
            <div className="max-w-md mx-auto w-full space-y-4 pb-24">
              <div className="flex items-center gap-3">
                <button onClick={() => setView('manuscript')} className="w-10 h-10 rounded-full bg-white shadow flex items-center justify-center text-stone-600 hover:bg-stone-900 hover:text-white transition-all" title="Về bản thảo">←</button>
                <div className="min-w-0">
                  <h2 className="story-font text-xl font-black text-stone-900 leading-tight">Nghe & Viết tự động</h2>
                  <p className="text-[11px] text-stone-400 truncate">{activeProject?.title || 'Chưa mở tác phẩm'}</p>
                </div>
              </div>

              <div className="surface p-5 space-y-3">
                <p className="story-font text-base font-black text-stone-800">{autoSession?.phase || 'Sẵn sàng. Chọn chế độ rồi bấm Bắt đầu.'}</p>
                {autoSession?.message && <p className="text-xs text-red-500 leading-relaxed">{autoSession.message}</p>}
                {generationStatus && autoSession?.running && <p className="text-[11px] text-stone-400">{generationStatus}</p>}
                <div className="flex gap-2 text-[10px] font-black uppercase">
                  <span className="px-2 py-1 bg-teal-50 text-teal-700 rounded-lg">Đã viết phiên này: {autoSession?.writtenThisSession.length || 0}{autoSession?.targetCount ? `/${autoSession.targetCount}` : ''}</span>
                  <span className={`px-2 py-1 rounded-lg ${ttsEngine === 'vieneu' ? 'bg-emerald-50 text-emerald-600' : 'bg-stone-100 text-stone-500'}`}>{ttsEngine === 'vieneu' ? 'Giọng VieNeu' : 'Giọng trình duyệt'}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <label className="flex items-center gap-2 bg-stone-50 rounded-xl px-3 py-2.5 cursor-pointer">
                    <input type="checkbox" checked={autoWriteEnabled} onChange={(e) => setAutoWriteEnabled(e.target.checked)} disabled={autoSession?.running} className="accent-teal-600 w-4 h-4" />
                    <span className="text-[11px] font-black uppercase text-stone-600">Tự viết tiếp</span>
                  </label>
                  <label className="flex items-center gap-2 bg-stone-50 rounded-xl px-3 py-2.5 cursor-pointer">
                    <input type="checkbox" checked={autoReadEnabled} onChange={(e) => setAutoReadEnabled(e.target.checked)} disabled={autoSession?.running} className="accent-teal-600 w-4 h-4" />
                    <span className="text-[11px] font-black uppercase text-stone-600">Tự đọc</span>
                  </label>
                  <label className="flex items-center gap-2 bg-stone-50 rounded-xl px-3 py-2.5 cursor-pointer">
                    <input type="checkbox" checked={autoReviewEnabled} onChange={(e) => setAutoReviewEnabled(e.target.checked)} disabled={autoSession?.running || !autoWriteEnabled} className="accent-teal-600 w-4 h-4" />
                    <span className="text-[11px] font-black uppercase text-stone-600">Cụm 2 + 3</span>
                  </label>
                  <label className="flex items-center gap-2 bg-stone-50 rounded-xl px-3 py-2.5">
                    <span className="text-[11px] font-black uppercase text-stone-600">Số chương</span>
                    <select value={autoChapterLimit} onChange={(e) => setAutoChapterLimit(Number(e.target.value))} disabled={autoSession?.running || !autoWriteEnabled} className="ml-auto bg-white rounded-lg px-2 py-1 text-[11px] font-black outline-none border">
                      {[1, 3, 5, 10, 0].map(n => <option key={n} value={n}>{n === 0 ? 'Hết lộ trình' : `${n} chương`}</option>)}
                    </select>
                  </label>
                </div>
                <label className="flex items-center gap-2 bg-stone-50 rounded-xl px-3 py-2.5">
                  <span className="text-[11px] font-black uppercase text-stone-600">Đọc từ chương</span>
                  <input type="number" min={0} value={autoReadFrom} onChange={(e) => setAutoReadFrom(Math.max(0, Number(e.target.value) || 0))} disabled={autoSession?.running || !autoReadEnabled} className="ml-auto w-20 bg-white rounded-lg px-2 py-1 text-[11px] font-black outline-none border text-center" />
                  <span className="text-[10px] text-stone-400">0 = tự động</span>
                </label>
                {autoSession?.running ? (
                  <button onClick={stopAutoSession} className="w-full py-4 bg-red-500 text-white rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-red-600 transition-all shadow-lg shadow-red-200">Dừng phiên</button>
                ) : (
                  <button onClick={() => void runAutoSession()} className="btn-primary w-full py-4 text-xs font-black uppercase tracking-widest">Bắt đầu</button>
                )}
              </div>

              {ttsSession && (
                <div className="bg-[#052e26] text-white rounded-3xl p-5 space-y-3 shadow-xl shadow-teal-950/25">
                  <div className="flex items-center gap-2">
                    <span>🔊</span>
                    <span className="font-black story-font text-sm truncate">Chương {ttsSession.chapterIndex}: {ttsSession.title}</span>
                  </div>
                  <p className="text-xs leading-relaxed text-teal-50/85 line-clamp-3 min-h-10">{ttsState === 'loading' ? 'Đang tổng hợp giọng đọc…' : ttsSegmentText}</p>
                  <div className="flex items-center gap-2">
                    <button onClick={() => void speechPlayerRef.current?.previous()} disabled={ttsIndex <= 0} className="px-3 py-2.5 bg-white/10 rounded-xl text-xs font-black hover:bg-white/25 transition-all disabled:opacity-35">⏮</button>
                    {ttsState === 'playing' ? (
                      <button onClick={() => speechPlayerRef.current?.pause()} className="flex-1 py-2.5 bg-amber-300 text-stone-900 rounded-xl text-xs font-black uppercase hover:brightness-110 transition-all">Tạm dừng</button>
                    ) : (
                      <button onClick={() => void speechPlayerRef.current?.play()} className="flex-1 py-2.5 bg-amber-300 text-stone-900 rounded-xl text-xs font-black uppercase hover:brightness-110 transition-all">{ttsState === 'loading' ? 'Đang tải…' : ttsState === 'ended' ? 'Nghe lại' : 'Nghe tiếp'}</button>
                    )}
                    <button onClick={() => void speechPlayerRef.current?.next()} disabled={ttsIndex >= ttsSession.total - 1} className="px-3 py-2.5 bg-white/10 rounded-xl text-xs font-black hover:bg-white/25 transition-all disabled:opacity-35">⏭</button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black text-teal-50/70">Đoạn {Math.min(ttsIndex + 1, ttsSession.total)}/{ttsSession.total}</span>
                    <select value={ttsRate} onChange={(e) => { const rate = Number(e.target.value); setTtsRateState(rate); speechPlayerRef.current?.setRate(rate); }} className="ml-auto bg-white/10 rounded-xl px-2 py-2 text-[11px] font-black outline-none [&>option]:text-stone-900">
                      {[0.75, 1, 1.25, 1.5, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}
                    </select>
                    {ttsVoices.length > 1 && (
                      <select value={ttsVoiceId} onChange={(e) => { setTtsVoiceId(e.target.value); speechPlayerRef.current?.setVoice(e.target.value); }} className="bg-white/10 rounded-xl px-2 py-2 text-[11px] font-black outline-none max-w-40 [&>option]:text-stone-900">
                        {ttsVoices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
                      </select>
                    )}
                  </div>
                </div>
              )}

              <div className="surface p-3 space-y-1">
                {sortChapters(Object.values(Object.fromEntries([...volumes.flatMap(v => v.chapters || []), ...writtenChapters].map(c => [c.index, c] as const)))).map(c => {
                  const isReading = autoSession?.readingIndex === c.index || ttsSession?.chapterIndex === c.index;
                  const isWriting = autoSession?.writingIndex === c.index;
                  return (
                    <button key={c.index} onClick={() => { if (c.content) void handleListenChapter(c); }} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${isReading ? 'bg-teal-50' : 'hover:bg-stone-50'}`}>
                      <span className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-[10px] font-black ${c.content ? 'bg-teal-600 text-white' : 'bg-stone-100 text-stone-400'}`}>{c.index}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs font-bold text-stone-700 truncate">{c.title || `Chương ${c.index}`}</span>
                        <span className="block text-[10px] text-stone-400">{c.content ? `${countWords(c.content)} chữ` : 'Chưa viết'}</span>
                      </span>
                      {isWriting && <span className="text-[9px] font-black uppercase text-orange-500">✍ Đang viết</span>}
                      {isReading && <span className="text-[9px] font-black uppercase text-teal-600">🔊 Đang đọc</span>}
                      {c.biblePending && <span className="text-[9px] font-black uppercase text-amber-600">⚠ Canon</span>}
                    </button>
                  );
                })}
                {!volumes.length && <p className="text-xs text-stone-400 px-3 py-4">Chưa có lộ trình. Hãy lập lộ trình Arc trước.</p>}
              </div>

              <p className="text-[11px] leading-relaxed text-stone-400 px-1">Nghe trong nền: với giọng VieNeu (chạy TTS Bridge trên máy tính, điện thoại kết nối cùng mạng/Tailscale), nhạc vẫn phát khi khóa màn hình và điều khiển được ngay từ màn hình khóa. Giọng của trình duyệt có thể bị hệ thống tạm dừng khi tắt màn hình — đó là giới hạn của trình duyệt, không phải của app.</p>
            </div>
          )}

          {view === 'manuscript' && (
             <div className="max-w-4xl mx-auto space-y-4 pb-20">
               <div className="flex flex-wrap justify-between items-center gap-3 mb-2">
                 <h2 className="text-3xl font-black italic story-font text-stone-900">Bản thảo lưu trữ</h2>
                 <div className="flex flex-wrap gap-2">
                   <span className="px-4 py-1 bg-stone-100 text-stone-500 rounded-full text-[10px] font-black">{writtenChapters.length} Chương</span>
                   <span className="px-4 py-1 bg-stone-100 text-stone-500 rounded-full text-[10px] font-black">{manuscriptTotalWords.toLocaleString('vi-VN')} chữ</span>
                   {manuscriptWeekWords > 0 && <span className="px-4 py-1 bg-emerald-50 text-emerald-600 rounded-full text-[10px] font-black">7 ngày qua: +{manuscriptWeekWords.toLocaleString('vi-VN')} chữ</span>}
                 </div>
               </div>
               <div className="flex flex-col lg:flex-row gap-2 lg:items-center">
                 <input value={manuscriptQuery} onChange={(e) => setManuscriptQuery(e.target.value)} placeholder="Tìm trong bản thảo (không cần gõ dấu)..." className="flex-1 px-4 py-3 rounded-xl border border-stone-200 bg-white text-sm font-medium text-stone-700 outline-none focus:border-amber-400" />
                 {manuscriptQuery && <button onClick={() => setManuscriptQuery('')} className="px-4 py-3 bg-stone-100 text-stone-500 rounded-xl text-[10px] font-black uppercase">Xóa tìm</button>}
                 <div className="flex flex-wrap gap-2">
                   <button onClick={() => { if (activeProject) handleExportManuscript(activeProject); }} className="px-4 py-3 bg-emerald-50 text-emerald-600 rounded-xl text-[10px] font-black uppercase hover:bg-emerald-600 hover:text-white transition-all">Xuất .txt</button>
                   <button onClick={() => setView('player')} className="px-4 py-3 bg-teal-600 text-white rounded-xl text-[10px] font-black uppercase hover:bg-teal-700 transition-all">▶ Nghe tự động</button>
                   <button onClick={() => { if (activeProject) handleExportMarkdown(activeProject, includeBibleInExport); }} className="px-4 py-3 bg-amber-50 text-orange-600 rounded-xl text-[10px] font-black uppercase hover:bg-orange-600 hover:text-white transition-all">Xuất .md</button>
                   <button onClick={() => { if (activeProject) void handleExportDocx(activeProject, includeBibleInExport); }} className="px-4 py-3 bg-sky-50 text-sky-600 rounded-xl text-[10px] font-black uppercase hover:bg-sky-600 hover:text-white transition-all">Xuất .docx</button>
                   <label className="flex items-center gap-2 px-3 py-3 bg-white border border-stone-200 rounded-xl text-[10px] font-black uppercase text-stone-500 cursor-pointer">
                     <input type="checkbox" checked={includeBibleInExport} onChange={(e) => setIncludeBibleInExport(e.target.checked)} className="accent-orange-600" />
                     Kèm Thiên Cơ Lục
                   </label>
                 </div>
               </div>
               {foldedManuscriptQuery && (
                 <p className="text-xs font-bold text-stone-500">Tìm thấy {visibleManuscriptChapters.length} chương chứa "{manuscriptQuery}" ({[...manuscriptMatchByIndex.values()].reduce((sum, n) => sum + n, 0)} lượt xuất hiện).</p>
               )}
               {visibleManuscriptChapters.map(c => {
                   const parentVol = volumes.find(v => (v.chapters || []).some(ch => ch.index === c.index));
                   const matchCount = manuscriptMatchByIndex.get(c.index);
                   return (
                     <div key={c.index} className="cv-auto p-6 md:p-8 bg-white border rounded-[2rem] flex flex-col gap-4 group shadow-sm hover:shadow-xl transition-all">
                       <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
                         <div className="flex flex-col gap-2">
                           <span className="text-[10px] font-black uppercase text-orange-400 tracking-widest">Chương {c.index} ({getWordCount(c.content || "")} chữ){matchCount ? ` · khớp ${matchCount} lượt` : ''}{c.biblePending ? ' · ⚠ Canon chờ cập nhật' : ''}</span>
                           <h4 className="font-black text-stone-800 story-font text-xl uppercase tracking-tight">{c.title}</h4>
                         </div>
                         <div className="flex flex-wrap items-center gap-2">
                           <button onClick={() => handleReadChapter(c, parentVol?.index || activeArcIndex)} className="px-6 py-3 bg-amber-50 text-orange-600 rounded-xl text-[10px] font-black uppercase hover:bg-stone-900 hover:text-white transition-all shadow-sm">Đọc</button>
                           <button onClick={() => void handleListenChapter(c)} className="px-6 py-3 bg-teal-50 text-teal-700 rounded-xl text-[10px] font-black uppercase hover:bg-teal-600 hover:text-white transition-all shadow-sm">Nghe</button>
                           <button onClick={() => handleRewriteChapter(c, parentVol?.index || activeArcIndex)} className="px-6 py-3 bg-stone-50 text-stone-500 rounded-xl text-[10px] font-black uppercase hover:bg-stone-800 hover:text-white transition-all shadow-sm">Viết lại</button>
                           {c.previousContent && (
                             <button onClick={() => setExpandedPreviousChapter(expandedPreviousChapter === c.index ? null : c.index)} className="px-4 py-3 bg-violet-50 text-violet-600 rounded-xl text-[10px] font-black uppercase hover:bg-violet-600 hover:text-white transition-all shadow-sm">Bản trước</button>
                           )}
                           <button onClick={(e) => handleDeleteChapter(c.index, parentVol?.index || activeArcIndex, e)} className="p-3 bg-red-50 text-red-400 rounded-xl hover:bg-red-600 hover:text-white transition-all">
                             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                           </button>
                         </div>
                       </div>
                       {expandedPreviousChapter === c.index && c.previousContent && (
                         <div className="border border-violet-100 bg-violet-50/40 rounded-2xl p-5 space-y-3">
                           <div className="flex flex-wrap justify-between items-center gap-2">
                             <span className="text-[10px] font-black uppercase tracking-widest text-violet-500">Bản trước — {getWordCount(c.previousContent)} chữ{c.previousContentAt ? ` · lưu lúc ${new Date(c.previousContentAt).toLocaleString('vi-VN')}` : ''}</span>
                             <button onClick={() => handleRestorePreviousContent(c)} className="px-4 py-2 bg-violet-600 text-white rounded-lg text-[10px] font-black uppercase hover:bg-violet-700 transition-all">Khôi phục bản này</button>
                           </div>
                           <div className="max-h-96 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-stone-600 bg-white/70 rounded-xl p-4">{c.previousContent}</div>
                         </div>
                       )}
                     </div>
                   );
                 })}
               {foldedManuscriptQuery && visibleManuscriptChapters.length === 0 && (
                 <p className="text-sm font-bold text-stone-400 text-center py-8">Không có chương nào chứa "{manuscriptQuery}".</p>
               )}
             </div>
          )}
        </div>
      </main>
      
      {ttsSession && view !== 'player' && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-1.5rem)] max-w-3xl bg-[#052e26]/95 backdrop-blur-xl border border-amber-200/25 text-white rounded-3xl shadow-2xl shadow-teal-950/40 px-5 py-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-base">🔊</span>
              <span className="font-black story-font text-sm truncate">Chương {ttsSession.chapterIndex}: {ttsSession.title}</span>
              <span className={`shrink-0 px-2 py-0.5 rounded-full text-[8px] font-black uppercase ${ttsEngine === 'vieneu' ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/10 text-stone-300'}`}>
                {ttsEngine === 'vieneu' ? 'Giọng VieNeu (máy này)' : 'Giọng trình duyệt'}
              </span>
            </div>
            <button onClick={handleCloseTts} className="shrink-0 w-8 h-8 rounded-full bg-white/10 hover:bg-white/25 transition-all text-sm" title="Đóng trình nghe">✕</button>
          </div>
          <p className="text-xs leading-relaxed text-teal-50/85 line-clamp-2 min-h-8">{ttsState === 'loading' ? 'Đang tổng hợp giọng đọc…' : ttsSegmentText}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => void speechPlayerRef.current?.previous()} disabled={ttsIndex <= 0} className="px-3 py-2 bg-white/10 rounded-xl text-xs font-black hover:bg-white/25 transition-all disabled:opacity-35" title="Đoạn trước">⏮</button>
            {ttsState === 'playing' ? (
              <button onClick={() => speechPlayerRef.current?.pause()} className="px-5 py-2 bg-amber-300 text-stone-900 rounded-xl text-xs font-black uppercase hover:brightness-110 transition-all">Tạm dừng</button>
            ) : (
              <button onClick={() => void speechPlayerRef.current?.play()} className="px-5 py-2 bg-amber-300 text-stone-900 rounded-xl text-xs font-black uppercase hover:brightness-110 transition-all">{ttsState === 'loading' ? 'Đang tải…' : ttsState === 'ended' ? 'Nghe lại' : 'Nghe tiếp'}</button>
            )}
            <button onClick={() => void speechPlayerRef.current?.next()} disabled={ttsIndex >= ttsSession.total - 1} className="px-3 py-2 bg-white/10 rounded-xl text-xs font-black hover:bg-white/25 transition-all disabled:opacity-35" title="Đoạn sau">⏭</button>
            <span className="text-[10px] font-black text-teal-50/70">Đoạn {Math.min(ttsIndex + 1, ttsSession.total)}/{ttsSession.total}</span>
            <select value={ttsRate} onChange={(e) => { const rate = Number(e.target.value); setTtsRateState(rate); speechPlayerRef.current?.setRate(rate); }} className="ml-auto bg-white/10 rounded-xl px-2 py-2 text-[11px] font-black outline-none [&>option]:text-stone-900" title="Tốc độ đọc">
              {[0.75, 1, 1.25, 1.5, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}
            </select>
            {ttsVoices.length > 1 && (
              <select value={ttsVoiceId} onChange={(e) => { setTtsVoiceId(e.target.value); speechPlayerRef.current?.setVoice(e.target.value); }} className="bg-white/10 rounded-xl px-2 py-2 text-[11px] font-black outline-none max-w-44 [&>option]:text-stone-900" title="Giọng đọc">
                {ttsVoices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
              </select>
            )}
            {ttsState === 'error' && <span className="text-[10px] font-black text-red-300">Lỗi phát — thử đoạn kế tiếp hoặc đóng mở lại</span>}
          </div>
          {ttsEngine === 'browser' && (
            <p className="text-[10px] text-teal-50/60">Đang dùng giọng của trình duyệt. Muốn giọng VieNeu tự nhiên hơn: chạy TTS Bridge trên máy này (mục Nghe truyện trong README của repo / file zip kèm theo) rồi mở lại chương.</p>
          )}
        </div>
      )}

      {(isGenerating || isGeneratingOutline || isCheckingLogic) && (
        <div className="fixed bottom-10 right-10 bg-stone-900 text-white px-8 py-5 rounded-3xl shadow-2xl flex items-center gap-5 z-50 animate-in slide-in-from-right-5">
          <div className="w-3 h-3 bg-orange-500 rounded-full animate-ping"></div>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-white uppercase tracking-widest">{isGenerating ? 'Chấp bút...' : isCheckingLogic ? 'Soi logic...' : 'Thấu thị...'}</span>
            <span className="text-[9px] text-orange-300 font-medium">{generationStatus}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
