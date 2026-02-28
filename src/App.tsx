import { useState, useRef, useEffect } from 'react';
import { Home, Info, Play, Square, Phone, Settings, Menu, X, Sun, Moon } from 'lucide-react';

export default function App() {
  const [apiKey, setApiKey] = useState(() => {
    // Check localStorage first, otherwise fallback to env variable
    return localStorage.getItem('openai_api_key') || import.meta.env.VITE_OPENAI_API_KEY || '';
  });
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(!apiKey);

  const [isSessionActive, setIsSessionActive] = useState(false);
  const [currentScreen, setCurrentScreen] = useState<'home' | 'about' | 'contact'>('home');
  const [language, setLanguage] = useState('English');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const getInstructions = (lang: string) => {
    return `You are a helpful assistant. You must ONLY converse in ${lang}. You can control the screen navigation via the \`change_screen\` tool. Respond succinctly without extra conversational filler. Navigate to the screen requested by the user.`;
  };

  const initSession = async () => {
    if (!apiKey) {
      setIsApiKeyModalOpen(true);
      setError("Please provide an OpenAI API key to start.");
      return;
    }
    setError(null);
    try {
      const tokenResponse = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview-2024-12-17",
          voice: "verse",
          instructions: getInstructions(language),
          tools: [
            {
              type: "function",
              name: "change_screen",
              description: "Navigate the UI to a different screen.",
              parameters: {
                type: "object",
                properties: {
                  screen: {
                    type: "string",
                    enum: ["home", "about", "contact"],
                    description: "The name of the screen to navigate to."
                  }
                },
                required: ["screen"]
              }
            }
          ],
          tool_choice: "auto"
        }),
      });

      if (!tokenResponse.ok) {
        throw new Error(`Failed to get ephemeral token: ${await tokenResponse.text()}`);
      }

      const tokenData = await tokenResponse.json();
      const ephemeralKey = tokenData.client_secret.value;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioElementRef.current = audioEl;

      pc.ontrack = (event) => {
        if (audioEl.srcObject !== event.streams[0]) {
          audioEl.srcObject = event.streams[0];
        }
      };

      const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTrack(ms.getTracks()[0], ms);

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        setIsSessionActive(true);
      });

      dc.addEventListener("close", () => {
        setIsSessionActive(false);
      });

      dc.addEventListener("message", (e) => {
        try {
          const serverEvent = JSON.parse(e.data);
          
          if (serverEvent.type === 'response.function_call_arguments.done') {
            if (serverEvent.name === 'change_screen') {
              const args = JSON.parse(serverEvent.arguments);
              if (args.screen === 'home' || args.screen === 'about' || args.screen === 'contact') {
                setCurrentScreen(args.screen as 'home' | 'about' | 'contact');
                
                dc.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: serverEvent.call_id,
                    output: `{"success": true, "message": "Screen changed to ${args.screen}"}`
                  }
                }));
                dc.send(JSON.stringify({ type: "response.create" }));
              }
            }
          }
          
          if (serverEvent.type === 'error') {
            console.error(`Server Error: ${serverEvent.error.message}`);
          }
        } catch (err) {
          console.error("Failed to parse message", err);
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp"
        },
      });

      if (!sdpResponse.ok) {
        throw new Error(`SDP negotiation failed: ${await sdpResponse.text()}`);
      }

      const answerSdp = await sdpResponse.text();
      const answer: RTCSessionDescriptionInit = {
        type: "answer" as RTCSdpType,
        sdp: answerSdp
      };

      await pc.setRemoteDescription(answer);

    } catch (err: any) {
      console.error(err);
      setError(err.message || "An error occurred.");
      stopSession();
    }
  };

  const stopSession = () => {
    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.getSenders().forEach((sender) => {
        if (sender.track) sender.track.stop();
      });
      pcRef.current.close();
      pcRef.current = null;
    }
    if (audioElementRef.current) {
      audioElementRef.current.srcObject = null;
      audioElementRef.current = null;
    }
    setIsSessionActive(false);
  };

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  useEffect(() => {
    if (isSessionActive && dcRef.current && dcRef.current.readyState === 'open') {
      try {
        dcRef.current.send(JSON.stringify({
          type: "session.update",
          session: {
            instructions: getInstructions(language)
          }
        }));
        
        // Trigger a response from the AI acknowledging the language change
        dcRef.current.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `The language has been changed to ${language}. Please acknowledge this and introduce yourself in ${language}.`
              }
            ]
          }
        }));
        dcRef.current.send(JSON.stringify({ type: "response.create" }));
      } catch (err) {
        console.error("Failed to update session language", err);
      }
    }
  }, [language, isSessionActive]);

  return (
    <div className="fixed inset-0 flex flex-col bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 font-sans overflow-hidden transition-colors duration-300">
      {/* Background decoration */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-blue-500/10 dark:bg-blue-900/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 dark:bg-purple-900/20 blur-[120px] rounded-full pointer-events-none" />

      {/* API Key Modal */}
      {isApiKeyModalOpen && (
        <div className="fixed inset-0 bg-neutral-950/80 backdrop-blur-md z-[100] flex items-center justify-center p-6 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-neutral-900 p-8 md:p-10 rounded-3xl border border-neutral-200 dark:border-neutral-800 shadow-2xl max-w-md w-full relative ring-1 ring-white/10 dark:ring-white/5">
            <button 
              onClick={() => setIsApiKeyModalOpen(false)}
              className="absolute top-6 right-6 p-2 text-neutral-400 hover:text-neutral-900 dark:hover:text-white rounded-xl transition-colors"
            >
              <X size={20} />
            </button>
            <h2 className="text-2xl font-bold text-neutral-900 dark:text-white mb-2">Configure API Key</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-8 leading-relaxed">
              We couldn't detect a built-in API key. To use the Realtime AI Navigator features, please enter your <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">OpenAI API Key</a>. It will be stored securely in your browser's local storage.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">OpenAI Secret Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full bg-neutral-50 dark:bg-neutral-950 border border-neutral-300 dark:border-neutral-800 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all"
                  placeholder="sk-..."
                />
              </div>
              <button
                onClick={() => {
                  if (apiKey.trim()) {
                    localStorage.setItem('openai_api_key', apiKey.trim());
                    setIsApiKeyModalOpen(false);
                    setError(null);
                  }
                }}
                disabled={!apiKey.trim()}
                className="w-full bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-4 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
              >
                Save & Continue
              </button>
            </div>
            {apiKey && (
              <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800 flex justify-center">
                <button 
                  onClick={() => setIsApiKeyModalOpen(false)}
                  className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 font-medium transition-colors"
                >
                  Cancel and Browse
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Mobile Menu Overlay */}
      {isMobileMenuOpen && (
        <div className="fixed inset-0 bg-white/95 dark:bg-neutral-950/95 backdrop-blur-3xl z-50 md:hidden flex flex-col p-6 animate-in fade-in duration-200">
          <div className="flex justify-end mb-8 pt-[env(safe-area-inset-top,2rem)] mt-6">
            <button onClick={() => setIsMobileMenuOpen(false)} className="p-2 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white bg-neutral-100 dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800">
              <X size={24} />
            </button>
          </div>
          
          <div className="flex flex-col gap-4 overflow-y-auto overscroll-y-contain [WebkitOverflowScrolling:touch]">
            <div className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">Navigation</div>
            <button 
              onClick={() => { setCurrentScreen('home'); setIsMobileMenuOpen(false); }}
              className={`flex items-center gap-4 px-4 py-4 rounded-xl transition-all ${currentScreen === 'home' ? 'bg-neutral-900 text-white dark:bg-neutral-800 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800/50'}`}
            >
              <Home size={20} /> Home
            </button>
            <button 
              onClick={() => { setCurrentScreen('about'); setIsMobileMenuOpen(false); }}
              className={`flex items-center gap-4 px-4 py-4 rounded-xl transition-all ${currentScreen === 'about' ? 'bg-neutral-900 text-white dark:bg-neutral-800 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800/50'}`}
            >
              <Info size={20} /> About
            </button>
            <button 
              onClick={() => { setCurrentScreen('contact'); setIsMobileMenuOpen(false); }}
              className={`flex items-center gap-4 px-4 py-4 rounded-xl transition-all ${currentScreen === 'contact' ? 'bg-neutral-900 text-white dark:bg-neutral-800 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800/50'}`}
            >
              <Phone size={20} /> Contact Us
            </button>

            <div className="h-px bg-neutral-200 dark:bg-neutral-800 my-4"></div>
            
            <div className="text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">Language</div>
            <div className="bg-neutral-100/50 dark:bg-neutral-900/50 p-2 rounded-xl border border-neutral-200 dark:border-neutral-800">
              <select
                value={language}
                onChange={(e) => { setLanguage(e.target.value); setIsMobileMenuOpen(false); }}
                className="w-full bg-transparent p-2 text-base text-neutral-900 dark:text-white font-medium focus:outline-none cursor-pointer outline-none"
              >
                <option value="English" className="bg-white dark:bg-neutral-900">English</option>
                <option value="Hindi" className="bg-white dark:bg-neutral-900">Hindi</option>
                <option value="Telugu" className="bg-white dark:bg-neutral-900">Telugu</option>
                <option value="Tamil" className="bg-white dark:bg-neutral-900">Tamil</option>
                <option value="Marathi" className="bg-white dark:bg-neutral-900">Marathi</option>
                <option value="Gujarati" className="bg-white dark:bg-neutral-900">Gujarati</option>
                <option value="Bengali" className="bg-white dark:bg-neutral-900">Bengali</option>
                <option value="Kannada" className="bg-white dark:bg-neutral-900">Kannada</option>
                <option value="Malayalam" className="bg-white dark:bg-neutral-900">Malayalam</option>
                <option value="Punjabi" className="bg-white dark:bg-neutral-900">Punjabi</option>
                <option value="Odia" className="bg-white dark:bg-neutral-900">Odia</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-red-100 dark:bg-red-900/90 border border-red-300 dark:border-red-800 text-red-800 dark:text-red-200 px-6 py-3 rounded-full text-sm shadow-xl backdrop-blur-md">
          {error}
        </div>
      )}

      <header className="flex-shrink-0 h-16 md:h-20 border-b border-neutral-200 dark:border-neutral-800 flex items-center px-4 md:px-8 justify-between bg-white/60 dark:bg-neutral-950/60 backdrop-blur-xl z-20">
        <div className="flex items-center gap-4 md:gap-8 min-w-0">
          <div 
            className="flex items-center gap-2 md:gap-3 mr-0 md:mr-4 min-w-0 cursor-pointer group"
            onClick={() => setIsApiKeyModalOpen(true)}
          >
            <div className={`h-8 w-8 md:h-10 md:w-10 rounded-xl flex-shrink-0 flex items-center justify-center bg-gradient-to-br transition-all group-hover:scale-105 ${isSessionActive ? 'from-green-500/20 to-green-600/10 border border-green-500/30' : 'from-blue-500/20 to-blue-600/10 border border-blue-500/30'}`}>
              <div className={`h-2 w-2 md:h-3 md:w-3 rounded-full ${isSessionActive ? 'bg-green-500 shadow-[0_0_15px_rgba(34,197,94,0.8)] animate-pulse' : 'bg-blue-500'}`} />
            </div>
            <div className="flex flex-col min-w-0">
              <h1 className="text-sm md:text-lg font-bold text-neutral-900 dark:text-white tracking-tight truncate group-hover:text-blue-500 transition-colors">AI Navigator</h1>
              <p className="text-[10px] md:text-xs text-neutral-500 dark:text-neutral-400 font-medium truncate group-hover:text-blue-500/70 transition-colors">{isSessionActive ? 'Listening...' : 'Ready to connect'}</p>
            </div>
          </div>
          
          <div className="hidden md:flex items-center gap-6 text-sm font-medium bg-neutral-100/50 dark:bg-neutral-900/50 p-1.5 rounded-xl border border-neutral-200 dark:border-neutral-800">
            <button 
              onClick={() => setCurrentScreen('home')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${currentScreen === 'home' ? 'bg-neutral-900 text-white dark:bg-neutral-800 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50'}`}
            >
              <Home size={16} /> Home
            </button>
            <button 
              onClick={() => setCurrentScreen('about')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${currentScreen === 'about' ? 'bg-neutral-900 text-white dark:bg-neutral-800 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50'}`}
            >
              <Info size={16} /> About
            </button>
            <button 
              onClick={() => setCurrentScreen('contact')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${currentScreen === 'contact' ? 'bg-neutral-900 text-white dark:bg-neutral-800 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50'}`}
            >
              <Phone size={16} /> Contact Us
            </button>
          </div>
        </div>
        
        <div className="flex items-center gap-2 md:gap-4 flex-shrink-0">
          
          <button
            onClick={toggleTheme}
            className="p-1.5 md:p-2 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white bg-neutral-100/50 dark:bg-neutral-900/50 rounded-xl border border-neutral-200 dark:border-neutral-800"
            title="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>

          <div className="flex items-center gap-2 group relative bg-neutral-100/50 dark:bg-neutral-900/50 p-1.5 rounded-xl border border-neutral-200 dark:border-neutral-800 hidden sm:flex">
            <div className="pl-3 text-neutral-400">
              <Settings size={16} />
            </div>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="bg-transparent pl-2 pr-8 py-1.5 text-sm text-neutral-700 dark:text-neutral-300 font-medium focus:outline-none cursor-pointer appearance-none outline-none"
            >
              <option value="English" className="bg-white dark:bg-neutral-900">English</option>
              <option value="Hindi" className="bg-white dark:bg-neutral-900">Hindi</option>
              <option value="Telugu" className="bg-white dark:bg-neutral-900">Telugu</option>
              <option value="Tamil" className="bg-white dark:bg-neutral-900">Tamil</option>
              <option value="Marathi" className="bg-white dark:bg-neutral-900">Marathi</option>
              <option value="Gujarati" className="bg-white dark:bg-neutral-900">Gujarati</option>
              <option value="Bengali" className="bg-white dark:bg-neutral-900">Bengali</option>
              <option value="Kannada" className="bg-white dark:bg-neutral-900">Kannada</option>
              <option value="Malayalam" className="bg-white dark:bg-neutral-900">Malayalam</option>
              <option value="Punjabi" className="bg-white dark:bg-neutral-900">Punjabi</option>
              <option value="Odia" className="bg-white dark:bg-neutral-900">Odia</option>
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-neutral-500">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path>
              </svg>
            </div>
          </div>

          <button
            onClick={isSessionActive ? stopSession : initSession}
            className={`flex flex-shrink-0 items-center gap-1.5 md:gap-2 py-1.5 md:py-2.5 px-3 md:px-6 rounded-xl font-semibold transition-all shadow-lg text-[11px] sm:text-xs md:text-base whitespace-nowrap ${
              isSessionActive
                ? "bg-red-100 text-red-600 border border-red-200 dark:bg-red-500/10 dark:text-red-500 dark:border-red-500/20 hover:bg-red-200 dark:hover:bg-red-500/20"
                : "bg-neutral-900 text-white hover:bg-neutral-800 border border-neutral-900/10 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200 dark:border-white/10 hover:scale-[1.02] active:scale-[0.98]"
            }`}
          >
            {isSessionActive ? (
              <>
                <Square size={14} className="md:w-4 md:h-4" /> <span className="hidden md:inline-block">Stop Session</span><span className="md:hidden">Stop</span>
              </>
            ) : (
              <>
                <Play size={14} fill="currentColor" className="md:w-4 md:h-4" /> <span className="hidden md:inline-block">Start AI Session</span><span className="md:hidden">Start</span>
              </>
            )}
          </button>

          {/* Hamburger Menu Button */}
          <button 
            className="md:hidden p-1.5 md:p-2 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white bg-neutral-100/50 dark:bg-neutral-900/50 rounded-xl border border-neutral-200 dark:border-neutral-800 ml-1"
            onClick={() => setIsMobileMenuOpen(true)}
          >
            <Menu size={18} />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto w-full p-6 md:p-12 flex flex-col items-center justify-start relative z-10 overscroll-y-contain [WebkitOverflowScrolling:touch]">
        <div className="w-full max-w-4xl relative">
          
          {currentScreen === 'home' && (
            <div className="bg-white/60 dark:bg-neutral-900/60 p-10 md:p-16 rounded-[2rem] border border-neutral-200/60 dark:border-neutral-800/60 shadow-2xl backdrop-blur-xl transform transition-all animate-in fade-in slide-in-from-bottom-8 duration-500">
              <div className="h-16 w-16 bg-gradient-to-br from-blue-500/20 to-blue-600/10 rounded-2xl flex items-center justify-center mb-8 border border-blue-500/20 shadow-inner">
                <Home className="text-blue-500 dark:text-blue-400" size={32} />
              </div>
              <h2 className="text-4xl md:text-5xl font-extrabold text-neutral-900 dark:text-white mb-6 tracking-tight">Welcome to the Future</h2>
              <p className="text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed max-w-2xl mb-10">
                This is a WebRTC demonstration leveraging the OpenAI Realtime API. Start the session using the button in the top right, then simply speak naturally. 
                Say <span className="text-neutral-900 dark:text-white font-medium">"Take me to the about page"</span> or <span className="text-neutral-900 dark:text-white font-medium">"I want to contact someone"</span> to see native client-side tool calling in action!
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-neutral-50/80 dark:bg-neutral-950/50 p-6 rounded-2xl border border-neutral-200 dark:border-neutral-800">
                  <h3 className="text-neutral-900 dark:text-white font-bold mb-2 flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-blue-500"></div> Ultra-Low Latency</h3>
                  <p className="text-sm text-neutral-600 dark:text-neutral-500">Audio is streamed directly via WebRTC, bypassing standard Text-to-Speech delays for incredibly fast response times.</p>
                </div>
                <div className="bg-neutral-50/80 dark:bg-neutral-950/50 p-6 rounded-2xl border border-neutral-200 dark:border-neutral-800">
                  <h3 className="text-neutral-900 dark:text-white font-bold mb-2 flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-purple-500"></div> Native Tool Calling</h3>
                  <p className="text-sm text-neutral-600 dark:text-neutral-500">The AI model emits function calls directly to the browser, updating React state instantly based on your voice commands.</p>
                </div>
              </div>
            </div>
          )}

          {currentScreen === 'about' && (
            <div className="bg-white/60 dark:bg-neutral-900/60 p-10 md:p-16 rounded-[2rem] border border-purple-200/50 dark:border-purple-800/20 shadow-2xl backdrop-blur-xl transform transition-all animate-in fade-in slide-in-from-bottom-8 duration-500">
              <div className="h-16 w-16 bg-gradient-to-br from-purple-500/20 to-purple-600/10 rounded-2xl flex items-center justify-center mb-8 border border-purple-500/20 shadow-inner">
                <Info className="text-purple-500 dark:text-purple-400" size={32} />
              </div>
              <h2 className="text-4xl md:text-5xl font-extrabold text-neutral-900 dark:text-white mb-6 tracking-tight">About The Tech</h2>
              <p className="text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed mb-10 max-w-2xl">
                You successfully navigated to this screen using only your voice! The AI processed your request, mapped your intent to a defined schema, and executed the <code className="text-purple-700 bg-purple-100 dark:text-purple-300 dark:bg-purple-900/30 px-2 py-1 rounded-md text-sm font-mono mx-1">change_screen</code> function over the WebRTC Data Channel.
              </p>
              
              <div className="bg-neutral-50/80 dark:bg-neutral-950/80 p-6 rounded-2xl border border-neutral-200 dark:border-neutral-800">
                <h3 className="text-sm font-bold text-neutral-500 dark:text-neutral-300 uppercase tracking-widest flex items-center gap-2 mb-4">
                  <Settings size={16} /> Architecture Flow
                </h3>
                <ol className="text-sm text-neutral-600 dark:text-neutral-400 space-y-4">
                  <li className="flex gap-4"><span className="flex-shrink-0 w-6 h-6 rounded-full bg-neutral-200 dark:bg-neutral-800 flex items-center justify-center text-xs font-bold text-neutral-700 dark:text-white">1</span> NextJS/Vite UI captures audio via getUserMedia()</li>
                  <li className="flex gap-4"><span className="flex-shrink-0 w-6 h-6 rounded-full bg-neutral-200 dark:bg-neutral-800 flex items-center justify-center text-xs font-bold text-neutral-700 dark:text-white">2</span> Audio streamed via WebRTC to OpenAI's Realtime API</li>
                  <li className="flex gap-4"><span className="flex-shrink-0 w-6 h-6 rounded-full bg-neutral-200 dark:bg-neutral-800 flex items-center justify-center text-xs font-bold text-neutral-700 dark:text-white">3</span> AI detects navigation intent and emits a JSON payload over the DataChannel</li>
                  <li className="flex gap-4"><span className="flex-shrink-0 w-6 h-6 rounded-full bg-neutral-200 dark:bg-neutral-800 flex items-center justify-center text-xs font-bold text-neutral-700 dark:text-white">4</span> React processes the payload and sets currentScreen state</li>
                </ol>
              </div>
            </div>
          )}

          {currentScreen === 'contact' && (
            <div className="bg-white/60 dark:bg-neutral-900/60 p-10 md:p-16 rounded-[2rem] border border-orange-200/50 dark:border-orange-800/20 shadow-2xl backdrop-blur-xl transform transition-all animate-in fade-in slide-in-from-bottom-8 duration-500">
              <div className="h-16 w-16 bg-gradient-to-br from-orange-500/20 to-orange-600/10 rounded-2xl flex items-center justify-center mb-8 border border-orange-500/20 shadow-inner">
                <Phone className="text-orange-500 dark:text-orange-400" size={32} />
              </div>
              <h2 className="text-4xl md:text-5xl font-extrabold text-neutral-900 dark:text-white mb-6 tracking-tight">Contact Us</h2>
              <p className="text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed mb-10 max-w-2xl">
                Have questions or need support with the OpenAI Realtime API implementation? We're here to help you build the future of voice interfaces.
              </p>
              
              <form className="space-y-4 max-w-md" onSubmit={(e) => e.preventDefault()}>
                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">Name</label>
                  <input type="text" className="w-full bg-white dark:bg-neutral-950 border border-neutral-300 dark:border-neutral-800 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/50 transition-all" placeholder="John Doe" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">Message</label>
                  <textarea rows={4} className="w-full bg-white dark:bg-neutral-950 border border-neutral-300 dark:border-neutral-800 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/50 transition-all resize-none" placeholder="I'd love to learn more..." />
                </div>
                <button className="w-full bg-orange-500 hover:bg-orange-600 dark:hover:bg-orange-400 text-white font-bold py-3 px-4 rounded-xl transition-colors mt-4">
                  Send Message
                </button>
              </form>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
