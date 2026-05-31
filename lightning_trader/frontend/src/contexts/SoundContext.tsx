/**
 * SoundContext — 音效播放與後端設定同步
 *
 * 後端會在 quote queue 推 {type:"Sound", event, volume}；TradingContext 收到
 * 後直接呼叫 useSoundContext().handleIncoming(msg) 進來播放。
 *
 * 前端 mute / volume 兩條獨立：
 *   - frontendMute：使用者本機設定（localStorage，立即生效，不打 API）
 *   - 後端設定：透過 setSoundConfig 同步給其他 client（多設定頁同時開）
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getSoundStatus, setSoundConfig as apiSetSoundConfig } from '../api/client';
import { playSound, unlockAudio } from '../utils/soundPlayer';

interface SoundContextType {
  muted: boolean;
  volume: number;
  setMuted: (m: boolean) => void;
  setVolume: (v: number) => void;
  handleIncoming: (msg: { event: string; volume?: number }) => void;
  testPlay: (event: string) => void;
}

const SoundContext = createContext<SoundContextType | null>(null);

const LS_MUTE = 'lighTrade_sound_muted';
const LS_VOL = 'lighTrade_sound_volume';

export const SoundProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [muted, setMutedState] = useState<boolean>(() => localStorage.getItem(LS_MUTE) === '1');
  const [volume, setVolumeState] = useState<number>(() => {
    const raw = localStorage.getItem(LS_VOL);
    const n = raw ? parseFloat(raw) : 0.5;
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
  });

  const mutedRef = useRef(muted);
  const volumeRef = useRef(volume);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  // 啟動時拉一次後端狀態，作為初始 hint（若後端已被設成 muted 也同步）
  useEffect(() => {
    getSoundStatus().then(s => {
      if (s.muted !== undefined && localStorage.getItem(LS_MUTE) === null) {
        setMutedState(s.muted);
      }
      if (s.volume !== undefined && localStorage.getItem(LS_VOL) === null) {
        setVolumeState(s.volume);
      }
    }).catch(() => { /* 後端 503 時靜默 */ });
  }, []);

  // 首次使用者互動 → 解鎖 AudioContext（瀏覽器強制）
  useEffect(() => {
    const unlock = () => { unlockAudio(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock);
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    localStorage.setItem(LS_MUTE, m ? '1' : '0');
    apiSetSoundConfig({ muted: m }).catch(() => { /* 不影響前端播放 */ });
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    localStorage.setItem(LS_VOL, String(clamped));
    apiSetSoundConfig({ volume: clamped }).catch(() => { /* noop */ });
  }, []);

  // alert / disconnect 不可被前端靜音（安全考量；對應後端 UNMUTABLE）
  const UNMUTABLE = ['alert', 'disconnect'];
  const handleIncoming = useCallback((msg: { event: string; volume?: number }) => {
    if (mutedRef.current && !UNMUTABLE.includes(msg.event)) return;
    const v = msg.volume ?? volumeRef.current;
    playSound(msg.event, v);
  }, []);

  const testPlay = useCallback((event: string) => {
    playSound(event, volumeRef.current);
  }, []);

  return (
    <SoundContext.Provider value={{ muted, volume, setMuted, setVolume, handleIncoming, testPlay }}>
      {children}
    </SoundContext.Provider>
  );
};

export const useSoundContext = (): SoundContextType => {
  const ctx = useContext(SoundContext);
  if (!ctx) throw new Error('useSoundContext must be used within SoundProvider');
  return ctx;
};
