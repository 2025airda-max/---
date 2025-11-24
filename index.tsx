import React, { useState, useEffect, useRef, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Modality } from "@google/genai";

const AI_KEY_POLL_INTERVAL = 1000;

// --- Types & State Management ---

interface FormState {
  videoPrompt: string;
  dialogue: string;
  aspectRatio: "16:9" | "9:16";
  uploadedImage: string | null;
  voiceName: string;
  backgroundMusic: string | null;
  bgMusicName: string | null;
  bgMusicVolume: number;
}

interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
}

type Action<T> = 
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'SET', payload: T }
  | { type: 'UPDATE_FIELD', field: keyof T, value: any };

function historyReducer<T>(state: HistoryState<T>, action: Action<T>): HistoryState<T> {
  const { past, present, future } = state;
  switch (action.type) {
    case 'UNDO':
      if (past.length === 0) return state;
      return {
        past: past.slice(0, past.length - 1),
        present: past[past.length - 1],
        future: [present, ...future]
      };
    case 'REDO':
      if (future.length === 0) return state;
      return {
        past: [...past, present],
        present: future[0],
        future: future.slice(1)
      };
    case 'SET':
      if (action.payload === present) return state;
      return {
        past: [...past, present],
        present: action.payload,
        future: []
      };
    case 'UPDATE_FIELD':
      const newState = { ...present, [action.field]: action.value };
      return {
        past: [...past, present],
        present: newState,
        future: []
      };
    default:
      return state;
  }
}

function useUndoRedo<T>(initialState: T) {
  const [state, dispatch] = useReducer(historyReducer<T>, {
    past: [],
    present: initialState,
    future: []
  });

  const undo = () => dispatch({ type: 'UNDO' });
  const redo = () => dispatch({ type: 'REDO' });
  const set = (payload: T) => dispatch({ type: 'SET', payload });
  const updateField = (field: keyof T, value: any) => dispatch({ type: 'UPDATE_FIELD', field, value });

  return { 
    state: state.present, 
    undo, 
    redo, 
    set, 
    updateField, 
    canUndo: state.past.length > 0, 
    canRedo: state.future.length > 0 
  };
}

// --- Main App Component ---

function App() {
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  
  // Undo/Redo State
  const { 
    state: formState, 
    updateField, 
    set: setFormState,
    undo, 
    redo, 
    canUndo, 
    canRedo 
  } = useUndoRedo<FormState>({
    videoPrompt: "",
    dialogue: "",
    aspectRatio: "16:9",
    uploadedImage: null,
    voiceName: "Kore",
    backgroundMusic: null,
    bgMusicName: null,
    bgMusicVolume: 0.15
  });

  // Keep a ref to formState for async access (transcription)
  const formStateRef = useRef(formState);
  useEffect(() => {
    formStateRef.current = formState;
  }, [formState]);
  
  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if target is input or textarea to decide if we should preventDefault?
      // Actually standard undo/redo shortcuts often work globally or focused.
      // We'll implement global app-level undo for these fields.
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  // Outputs (Not part of undo/redo history usually)
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  
  // Recording
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio && await window.aistudio.hasSelectedApiKey()) {
        setHasKey(true);
      }
    };
    checkKey();
    const interval = setInterval(checkKey, AI_KEY_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  const handleSelectKey = async () => {
    if (window.aistudio) {
      await window.aistudio.openSelectKey();
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        updateField('uploadedImage', reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleMusicUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setFormState({
          ...formState,
          backgroundMusic: reader.result as string,
          bgMusicName: file.name
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const removeMusic = () => {
    setFormState({
      ...formState,
      backgroundMusic: null,
      bgMusicName: null
    });
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setStatus("Error accessing microphone.");
    }
  };

  const stopRecordingAndTranscribe = async () => {
    if (!mediaRecorderRef.current) return;

    setStatus("Transcribing audio...");
    mediaRecorderRef.current.stop();
    setIsRecording(false);

    // Wait a bit for the last chunk
    await new Promise((resolve) => setTimeout(resolve, 500));

    const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
    const reader = new FileReader();
    reader.readAsDataURL(audioBlob);
    reader.onloadend = async () => {
      const base64Audio = (reader.result as string).split(',')[1];
      
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: {
            parts: [
              { inlineData: { mimeType: 'audio/webm', data: base64Audio } },
              { text: "Transcribe the spoken audio exactly." }
            ]
          }
        });
        
        if (response.text) {
          // Use ref to get latest state for concatenation
          const currentDialogue = formStateRef.current.dialogue;
          const newDialogue = currentDialogue ? currentDialogue + " " + response.text : response.text;
          updateField('dialogue', newDialogue);
          setStatus("Transcription complete.");
        }
      } catch (e) {
        console.error(e);
        setStatus("Transcription failed.");
      }
    };
  };

  const generateScene = async () => {
    const { videoPrompt, uploadedImage, dialogue, voiceName, aspectRatio } = formState;

    if (!videoPrompt && !uploadedImage) {
      setStatus("Please provide a video prompt or an image.");
      return;
    }

    setLoading(true);
    setVideoUri(null);
    setAudioUri(null);
    
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    try {
      // 1. Generate Audio (if dialogue exists)
      let generatedAudioUrl = null;
      if (dialogue) {
        setStatus("Generating voiceover...");
        const audioResponse = await ai.models.generateContent({
          model: "gemini-2.5-flash-preview-tts",
          contents: { parts: [{ text: dialogue }] },
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voiceName },
              },
            },
          },
        });
        
        const audioData = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (audioData) {
          const binaryString = atob(audioData);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const wavBytes = addWavHeader(bytes, 24000, 1);
          const wavBlob = new Blob([wavBytes], { type: 'audio/wav' });
          generatedAudioUrl = URL.createObjectURL(wavBlob);
          setAudioUri(generatedAudioUrl);
        }
      }

      // 2. Generate Video
      setStatus("Generating video with Veo (this may take a minute)...");
      
      let operation;
      const veoConfig = {
        numberOfVideos: 1,
        resolution: "1080p", // Veo Fast supports 720p/1080p
        aspectRatio: aspectRatio,
      };

      if (uploadedImage) {
        const base64Image = uploadedImage.split(',')[1];
        const mimeType = uploadedImage.split(';')[0].split(':')[1];
        operation = await ai.models.generateVideos({
          model: 'veo-3.1-fast-generate-preview',
          prompt: videoPrompt || "Animate this image", 
          image: {
            imageBytes: base64Image,
            mimeType: mimeType,
          },
          config: veoConfig
        });
      } else {
        operation = await ai.models.generateVideos({
          model: 'veo-3.1-fast-generate-preview',
          prompt: videoPrompt,
          config: veoConfig
        });
      }

      // Poll for completion
      while (!operation.done) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        operation = await ai.operations.getVideosOperation({ operation: operation });
        setStatus("Veo is thinking...");
      }

      const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
      if (videoUri) {
        const vidResponse = await fetch(`${videoUri}&key=${process.env.API_KEY}`);
        const vidBlob = await vidResponse.blob();
        const vidUrl = URL.createObjectURL(vidBlob);
        setVideoUri(vidUrl);
      } else {
        throw new Error("No video returned");
      }

      setStatus("Scene generation complete!");

    } catch (error) {
      console.error(error);
      setStatus(`Error: ${error.message || "Unknown error occurred"}`);
    } finally {
      setLoading(false);
    }
  };

  // Helper to add WAV header
  const addWavHeader = (samples: Uint8Array, sampleRate: number, numChannels: number) => {
    const buffer = new ArrayBuffer(44 + samples.length);
    const view = new DataView(buffer);
    
    const writeString = (view: DataView, offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true); // 16 bits per sample
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length, true);

    const dataView = new Uint8Array(buffer);
    dataView.set(samples, 44);
    
    return dataView;
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const bgMusicRef = useRef<HTMLAudioElement>(null);
  const dialogueRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll effect: Scrolls to bottom when dialogue updates, unless user is editing (focused)
  useEffect(() => {
    if (dialogueRef.current && document.activeElement !== dialogueRef.current) {
      dialogueRef.current.scrollTop = dialogueRef.current.scrollHeight;
    }
  }, [formState.dialogue]);

  const playScene = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play();
    }
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
    }
    if (bgMusicRef.current && formState.backgroundMusic) {
      bgMusicRef.current.volume = formState.bgMusicVolume;
      bgMusicRef.current.currentTime = 0;
      bgMusicRef.current.play();
    }
  };

  if (!hasKey) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
        <h1 className="text-3xl font-bold mb-6 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">
          Interactive AI Studio
        </h1>
        <p className="mb-8 text-gray-400 text-center max-w-md">
          To generate high-quality Veo videos and use premium AI features, you need to connect a paid API key.
        </p>
        <button 
          onClick={handleSelectKey}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-semibold transition-colors shadow-lg shadow-blue-900/50"
        >
          Connect API Key
        </button>
        <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" className="mt-4 text-sm text-gray-500 hover:text-gray-300">
          Billing Information
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans selection:bg-purple-500 selection:text-white">
      <style>{`
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { bg: #1f2937; }
        ::-webkit-scrollbar-thumb { background: #4b5563; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #6b7280; }
        input[type=range] {
          -webkit-appearance: none; 
          background: transparent;
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          height: 16px;
          width: 16px;
          border-radius: 50%;
          background: #d8b4fe;
          cursor: pointer;
          margin-top: -6px;
        }
        input[type=range]::-webkit-slider-runnable-track {
          width: 100%;
          height: 4px;
          background: #4b5563;
          border-radius: 2px;
        }
      `}</style>
      
      <div className="container mx-auto max-w-5xl p-6">
        <header className="mb-10 flex items-center justify-between border-b border-gray-800 pb-6">
          <div>
            <h1 className="text-4xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
              CineGen AI
            </h1>
            <p className="text-gray-400 mt-2">Interactive Video & Scene Generator</p>
          </div>
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${loading ? 'bg-yellow-400 animate-pulse' : 'bg-green-400'}`}></div>
            <span className="text-xs text-gray-500 uppercase tracking-wider">{loading ? 'Processing' : 'Ready'}</span>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Controls Section */}
          <div className="space-y-6">
            
            {/* Undo/Redo Toolbar */}
            <div className="flex justify-between items-center mb-2 px-1">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <span className="material-symbols-outlined text-purple-400">tune</span>
                Configuration
              </h2>
              <div className="flex bg-gray-900 rounded-lg p-1 border border-gray-700 shadow-sm">
                <button
                  onClick={undo}
                  disabled={!canUndo}
                  className={`p-2 rounded-md transition-all ${!canUndo ? 'opacity-30 cursor-not-allowed' : 'text-gray-300 hover:bg-gray-800 hover:text-white'}`}
                  title="Undo (Ctrl+Z)"
                >
                  <span className="material-symbols-outlined text-sm">undo</span>
                </button>
                <div className="w-px bg-gray-700 mx-1 my-1"></div>
                <button
                  onClick={redo}
                  disabled={!canRedo}
                  className={`p-2 rounded-md transition-all ${!canRedo ? 'opacity-30 cursor-not-allowed' : 'text-gray-300 hover:bg-gray-800 hover:text-white'}`}
                  title="Redo (Ctrl+Y)"
                >
                  <span className="material-symbols-outlined text-sm">redo</span>
                </button>
              </div>
            </div>

            <div className="bg-gray-900 p-6 rounded-2xl border border-gray-800 shadow-xl">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">Visuals</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Video Prompt</label>
                  <textarea
                    value={formState.videoPrompt}
                    onChange={(e) => updateField('videoPrompt', e.target.value)}
                    placeholder="Describe the scene video (e.g., A cyberpunk city in rain, neon lights reflecting...)"
                    className="w-full bg-gray-950 border border-gray-700 rounded-lg p-3 text-sm focus:ring-2 focus:ring-purple-500 outline-none transition-all h-24 resize-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Aspect Ratio</label>
                    <div className="flex bg-gray-950 rounded-lg p-1 border border-gray-700">
                      {(["16:9", "9:16"] as const).map(ratio => (
                        <button
                          key={ratio}
                          onClick={() => updateField('aspectRatio', ratio)}
                          className={`flex-1 py-2 text-xs font-medium rounded-md transition-all ${
                            formState.aspectRatio === ratio 
                              ? "bg-gray-800 text-white shadow-sm" 
                              : "text-gray-500 hover:text-gray-300"
                          }`}
                        >
                          {ratio}
                        </button>
                      ))}
                    </div>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Reference Image</label>
                    <label className="flex items-center justify-center w-full h-[42px] px-4 transition bg-gray-950 border border-gray-700 border-dashed rounded-lg appearance-none cursor-pointer hover:border-purple-500 hover:bg-gray-900 group">
                      <span className="flex items-center space-x-2">
                        <span className="material-symbols-outlined text-gray-400 group-hover:text-purple-400 transition-colors text-sm">
                          {formState.uploadedImage ? "check_circle" : "upload"}
                        </span>
                        <span className="text-xs text-gray-400 truncate max-w-[100px] group-hover:text-gray-300 transition-colors">
                          {formState.uploadedImage ? "Change Image" : "Upload Image"}
                        </span>
                      </span>
                      <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 p-6 rounded-2xl border border-gray-800 shadow-xl">
               <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4 flex items-center justify-between">
                 <span>Audio & Dialogue</span>
                 <button 
                    onClick={isRecording ? stopRecordingAndTranscribe : startRecording}
                    className={`text-xs flex items-center gap-1 px-3 py-1 rounded-full transition-all ${
                      isRecording ? "bg-red-500/20 text-red-400 animate-pulse border border-red-500/30" : "bg-gray-800 text-gray-400 hover:bg-gray-700 border border-gray-700"
                    }`}
                 >
                   <span className="material-symbols-outlined text-[14px]">{isRecording ? "stop_circle" : "mic"}</span>
                   {isRecording ? "Stop & Transcribe" : "Record"}
                 </button>
               </h3>
              
              <div className="space-y-4">
                 <div>
                  <textarea
                    ref={dialogueRef}
                    value={formState.dialogue}
                    onChange={(e) => updateField('dialogue', e.target.value)}
                    placeholder="What should the character say?"
                    className="w-full bg-gray-950 border border-gray-700 rounded-lg p-3 text-sm focus:ring-2 focus:ring-pink-500 outline-none transition-all h-24 resize-none"
                  />
                </div>

                <div>
                   <label className="block text-sm font-medium text-gray-400 mb-1">Voice Personality</label>
                   <select 
                      value={formState.voiceName}
                      onChange={(e) => updateField('voiceName', e.target.value)}
                      className="w-full bg-gray-950 border border-gray-700 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-pink-500 outline-none hover:border-gray-600 transition-colors"
                   >
                     {["Kore", "Puck", "Charon", "Fenrir", "Zephyr"].map(v => (
                       <option key={v} value={v}>{v}</option>
                     ))}
                   </select>
                </div>

                <div className="pt-2 border-t border-gray-800">
                  <label className="block text-sm font-medium text-gray-400 mb-2">Background Music</label>
                  <div className="flex gap-4 items-start">
                    <div className="flex-1">
                       {!formState.backgroundMusic ? (
                          <label className="flex items-center justify-center w-full px-4 py-3 transition bg-gray-950 border border-gray-700 border-dashed rounded-lg appearance-none cursor-pointer hover:border-pink-500 hover:bg-gray-900 group">
                            <span className="flex items-center gap-2">
                              <span className="material-symbols-outlined text-gray-400 group-hover:text-pink-400 text-sm">music_note</span>
                              <span className="text-xs text-gray-400 group-hover:text-gray-300">Upload Music</span>
                            </span>
                            <input type="file" accept="audio/*" onChange={handleMusicUpload} className="hidden" />
                          </label>
                       ) : (
                          <div className="flex items-center justify-between w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded-lg">
                             <div className="flex items-center gap-2 overflow-hidden">
                               <span className="material-symbols-outlined text-pink-400 text-sm">music_note</span>
                               <span className="text-xs text-gray-300 truncate max-w-[120px]">{formState.bgMusicName}</span>
                             </div>
                             <button onClick={removeMusic} className="text-gray-500 hover:text-red-400">
                               <span className="material-symbols-outlined text-sm">close</span>
                             </button>
                          </div>
                       )}
                    </div>
                    
                    <div className="w-1/3 flex flex-col justify-center gap-1">
                      <div className="flex justify-between text-[10px] text-gray-500">
                         <span>Vol</span>
                         <span>{Math.round(formState.bgMusicVolume * 100)}%</span>
                      </div>
                      <input 
                        type="range" 
                        min="0" 
                        max="1" 
                        step="0.05"
                        value={formState.bgMusicVolume}
                        onChange={(e) => updateField('bgMusicVolume', parseFloat(e.target.value))}
                        className="w-full"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <button
              onClick={generateScene}
              disabled={loading}
              className={`w-full py-4 rounded-xl font-bold text-lg shadow-lg transition-all transform active:scale-[0.98] ${
                loading 
                  ? "bg-gray-800 text-gray-500 cursor-not-allowed" 
                  : "bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-indigo-900/50"
              }`}
            >
              {loading ? "Generating Scene..." : "Generate Scene"}
            </button>
            
            {status && (
              <div className="text-center text-sm text-gray-400 bg-gray-900/50 py-2 rounded-lg border border-gray-800 animate-fade-in">
                {status}
              </div>
            )}
          </div>

          {/* Preview Section */}
          <div className="flex flex-col gap-6">
            <div className="bg-gray-900 rounded-2xl border border-gray-800 shadow-xl overflow-hidden min-h-[400px] flex flex-col">
              <div className="p-4 border-b border-gray-800 flex justify-between items-center bg-gray-900/50 backdrop-blur">
                <h3 className="font-medium text-gray-300">Scene Preview</h3>
                {(videoUri || audioUri || (formState.backgroundMusic && videoUri)) && (
                   <button 
                     onClick={playScene}
                     className="text-xs bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 rounded-full flex items-center gap-1 transition-colors"
                   >
                     <span className="material-symbols-outlined text-sm">play_arrow</span>
                     Play All
                   </button>
                )}
              </div>
              
              <div className="flex-1 relative bg-black flex items-center justify-center group overflow-hidden">
                {loading ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center z-20">
                    {formState.uploadedImage && (
                      <div className="absolute inset-0 z-0">
                        <img 
                          src={formState.uploadedImage} 
                          alt="Processing Reference" 
                          className="w-full h-full object-cover opacity-20 blur-md scale-110 transition-transform duration-[60s]" 
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-black" />
                      </div>
                    )}
                    <div className="relative z-10 flex flex-col items-center p-8 bg-gray-950/80 backdrop-blur-xl rounded-2xl border border-gray-800 shadow-2xl mx-4">
                      <div className="relative w-16 h-16 mb-4">
                        <div className="absolute inset-0 rounded-full border-4 border-indigo-500/30"></div>
                        <div className="absolute inset-0 rounded-full border-4 border-t-indigo-500 border-r-transparent border-b-transparent border-l-transparent animate-spin"></div>
                      </div>
                      <h4 className="text-lg font-bold text-white mb-1">Generating Video</h4>
                      <p className="text-sm text-gray-400 text-center max-w-xs animate-pulse">
                        {status || "Dreaming up your scene with Veo..."}
                      </p>
                    </div>
                  </div>
                ) : videoUri ? (
                  <video 
                    ref={videoRef}
                    src={videoUri} 
                    className={`w-full h-full object-contain ${formState.aspectRatio === "9:16" ? "max-w-[300px]" : ""}`}
                    controls 
                    playsInline
                    loop
                  />
                ) : (
                  <div className="text-center p-8">
                     <div className="w-16 h-16 rounded-full bg-gray-800 mx-auto flex items-center justify-center mb-4 border border-gray-700">
                       <span className="material-symbols-outlined text-gray-600 text-3xl">movie</span>
                     </div>
                     <p className="text-gray-500">Generated video will appear here</p>
                  </div>
                )}
                
                {/* Overlay Audio Player if Audio Exists */}
                {audioUri && (
                   <div className="absolute bottom-4 left-4 right-4 bg-gray-900/90 backdrop-blur border border-gray-700 rounded-lg p-2 flex items-center gap-3 z-30">
                      <div className="w-8 h-8 rounded-full bg-pink-500/20 flex items-center justify-center text-pink-400">
                        <span className="material-symbols-outlined text-sm">graphic_eq</span>
                      </div>
                      <audio ref={audioRef} src={audioUri} controls className="h-8 w-full opacity-80" />
                   </div>
                )}
                
                {/* Hidden Background Music Player */}
                {formState.backgroundMusic && (
                  <audio ref={bgMusicRef} src={formState.backgroundMusic} loop className="hidden" />
                )}
              </div>
            </div>
            
            {/* Context/Log Area */}
            <div className="bg-gray-900 p-6 rounded-2xl border border-gray-800 shadow-xl flex-1">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Script & Notes</h3>
              <div className="space-y-3">
                {formState.videoPrompt && (
                   <div className="text-sm">
                      <span className="text-indigo-400 font-medium">Visuals:</span> 
                      <span className="text-gray-400 ml-2">{formState.videoPrompt}</span>
                   </div>
                )}
                {formState.dialogue && (
                   <div className="text-sm">
                      <span className="text-pink-400 font-medium">{formState.voiceName}:</span> 
                      <span className="text-gray-300 ml-2">"{formState.dialogue}"</span>
                   </div>
                )}
                {formState.bgMusicName && (
                   <div className="text-sm flex items-center gap-2">
                      <span className="material-symbols-outlined text-gray-500 text-xs">music_note</span>
                      <span className="text-gray-500 italic">Background: {formState.bgMusicName} ({Math.round(formState.bgMusicVolume * 100)}%)</span>
                   </div>
                )}
                {!formState.videoPrompt && !formState.dialogue && !formState.bgMusicName && (
                  <p className="text-sm text-gray-600 italic">No script generated yet.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
} else {
  console.error("Root element not found");
}
