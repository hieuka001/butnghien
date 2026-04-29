import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const isVercel = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
    const exposeClientGeminiKeys = !isVercel || env.GEMINI_CLIENT_EXPOSE === 'true';
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.GEMINI_API_KEY': JSON.stringify(exposeClientGeminiKeys ? env.GEMINI_API_KEY : ''),
        'process.env.GEMINI_API_KEY_1': JSON.stringify(exposeClientGeminiKeys ? env.GEMINI_API_KEY_1 : ''),
        'process.env.GEMINI_API_KEY_2': JSON.stringify(exposeClientGeminiKeys ? env.GEMINI_API_KEY_2 : ''),
        'process.env.GEMINI_API_KEY_3': JSON.stringify(exposeClientGeminiKeys ? env.GEMINI_API_KEY_3 : ''),
        'process.env.GEMINI_API_KEY_4': JSON.stringify(exposeClientGeminiKeys ? env.GEMINI_API_KEY_4 : ''),
        'process.env.GEMINI_API_KEY_5': JSON.stringify(exposeClientGeminiKeys ? env.GEMINI_API_KEY_5 : ''),
        'process.env.GEMINI_API_KEYS': JSON.stringify(exposeClientGeminiKeys ? env.GEMINI_API_KEYS : ''),
        'process.env.GEMINI_SERVER_PROXY': JSON.stringify(isVercel || env.GEMINI_SERVER_PROXY === 'true' ? 'true' : ''),
        'process.env.GEMINI_MODEL': JSON.stringify(env.GEMINI_MODEL),
        'process.env.GEMINI_PLAN_MODEL': JSON.stringify(env.GEMINI_PLAN_MODEL),
        'process.env.GEMINI_WRITE_MODEL': JSON.stringify(env.GEMINI_WRITE_MODEL),
        'process.env.GEMINI_MAX_OUTPUT_TOKENS': JSON.stringify(env.GEMINI_MAX_OUTPUT_TOKENS),
        'process.env.FIREBASE_API_KEY': JSON.stringify(env.FIREBASE_API_KEY || env.VITE_FIREBASE_API_KEY || ''),
        'process.env.FIREBASE_AUTH_DOMAIN': JSON.stringify(env.FIREBASE_AUTH_DOMAIN || env.VITE_FIREBASE_AUTH_DOMAIN || ''),
        'process.env.FIREBASE_PROJECT_ID': JSON.stringify(env.FIREBASE_PROJECT_ID || env.VITE_FIREBASE_PROJECT_ID || ''),
        'process.env.FIREBASE_APP_ID': JSON.stringify(env.FIREBASE_APP_ID || env.VITE_FIREBASE_APP_ID || ''),
        'process.env.FIREBASE_DATABASE_ID': JSON.stringify(env.FIREBASE_DATABASE_ID || env.VITE_FIREBASE_DATABASE_ID || '(default)'),
        'process.env.VITE_FIREBASE_API_KEY': JSON.stringify(env.VITE_FIREBASE_API_KEY || env.FIREBASE_API_KEY || ''),
        'process.env.VITE_FIREBASE_AUTH_DOMAIN': JSON.stringify(env.VITE_FIREBASE_AUTH_DOMAIN || env.FIREBASE_AUTH_DOMAIN || ''),
        'process.env.VITE_FIREBASE_PROJECT_ID': JSON.stringify(env.VITE_FIREBASE_PROJECT_ID || env.FIREBASE_PROJECT_ID || ''),
        'process.env.VITE_FIREBASE_APP_ID': JSON.stringify(env.VITE_FIREBASE_APP_ID || env.FIREBASE_APP_ID || ''),
        'process.env.VITE_FIREBASE_DATABASE_ID': JSON.stringify(env.VITE_FIREBASE_DATABASE_ID || env.FIREBASE_DATABASE_ID || '(default)')
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
