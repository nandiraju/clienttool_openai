import { useState, useRef, useEffect } from 'react';
import { Home, Info, Play, Square, Phone, Settings, Menu, X, Sun, Moon, Mic } from 'lucide-react';

const LANGUAGES = [
  "English", "Hindi", "Telugu", "Tamil", "Marathi", 
  "Gujarati", "Bengali", "Kannada", "Malayalam", "Punjabi", "Odia"
];

const VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"
];

export default function App() {
  const [apiKey, setApiKey] = useState(() => {
    // Check localStorage first, otherwise fallback to env variable
    return localStorage.getItem('openai_api_key') || import.meta.env.VITE_OPENAI_API_KEY || '';
  });

  const [isSessionActive, setIsSessionActive] = useState(false);
  const [currentScreen, setCurrentScreen] = useState<'home' | 'about' | 'contact' | 'settings'>('home');
  const [language, setLanguage] = useState('English');
  const [voice, setVoice] = useState('verse');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [contactName, setContactName] = useState('');
  const [contactMessage, setContactMessage] = useState('');
  
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // GSAP Animation whenever screen changes
  useEffect(() => {
    if ((window as any).gsap && screenRef.current) {
      const elements = screenRef.current.children;
      (window as any).gsap.fromTo(
        elements,
        { opacity: 0, y: 20 },
        { opacity: 1, y: 0, duration: 0.5, stagger: 0.1, ease: 'power2.out', clearProps: 'all' }
      );
    }
  }, [currentScreen]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const saveSettings = () => {
    if (apiKey.trim()) {
      localStorage.setItem('openai_api_key', apiKey.trim());
    }
    setError(null);
    setCurrentScreen('home');
  };

  const getInstructions = (lang: string) => {
    return `You are a helpful assistant. You must ONLY converse in ${lang}. You can control the screen navigation via the \`change_screen\` tool, you can switch the visual theme between light and dark modes using the \`change_theme\` tool, and you can fill out the contact form automatically using the \`fill_contact_form\` tool. Respond succinctly without extra conversational filler. If a user asks to contact you, navigate them to the 'contact' screen first, then ask them for their name or message, and finally use the tool to populate the form on their screen.`;
  };

  const initSession = async () => {
    if (!apiKey) {
      setCurrentScreen('settings');
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
          voice: voice,
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
                    enum: ["home", "about", "contact", "settings"],
                    description: "The name of the screen to navigate to."
                  }
                },
                required: ["screen"]
              }
            },
            {
              type: "function",
              name: "change_theme",
              description: "Change the application theme to either 'light' or 'dark'.",
              parameters: {
                type: "object",
                properties: {
                  theme: {
                    type: "string",
                    enum: ["light", "dark"],
                    description: "The theme to switch to."
                  }
                },
                required: ["theme"]
              }
            },
            {
              type: "function",
              name: "fill_contact_form",
              description: "Populate the Name and Message fields on the Contact Us form.",
              parameters: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "The name of the user."
                  },
                  message: {
                    type: "string",
                    description: "The message the user wishes to send."
                  }
                },
                required: ["name", "message"]
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
              if (args.screen === 'home' || args.screen === 'about' || args.screen === 'contact' || args.screen === 'settings') {
                setCurrentScreen(args.screen as 'home' | 'about' | 'contact' | 'settings');
                
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
            } else if (serverEvent.name === 'change_theme') {
              const args = JSON.parse(serverEvent.arguments);
              if (args.theme === 'light' || args.theme === 'dark') {
                setTheme(args.theme as 'light' | 'dark');
                
                dc.send(JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: serverEvent.call_id,
                    output: `{"success": true, "message": "Theme changed to ${args.theme}"}`
                  }
                }));
                dc.send(JSON.stringify({ type: "response.create" }));
              }
            } else if (serverEvent.name === 'fill_contact_form') {
              const args = JSON.parse(serverEvent.arguments);
              setContactName(args.name || '');
              setContactMessage(args.message || '');
              
              dc.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: serverEvent.call_id,
                  output: `{"success": true, "message": "Contact form populated with Name: ${args.name} and Message: ${args.message}"}`
                }
              }));
              dc.send(JSON.stringify({ type: "response.create" }));
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
                text: `The language has been changed to ${language}. Please acknowledge this and introduce yourself in ${language} without asking how to help.`
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

  useEffect(() => {
    if (isSessionActive && dcRef.current && dcRef.current.readyState === 'open') {
      try {
        dcRef.current.send(JSON.stringify({
          type: "session.update",
          session: {
            voice: voice
          }
        }));
        
        // Trigger a response from the AI acknowledging the voice change
        dcRef.current.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `The system voice has been changed to ${voice}. Please acknowledge this change and say a brief greeting so the user can hear your new voice.`
              }
            ]
          }
        }));
        dcRef.current.send(JSON.stringify({ type: "response.create" }));
      } catch (err) {
        console.error("Failed to update session voice", err);
      }
    }
  }, [voice, isSessionActive]);

  return (
    <div className="fixed inset-0 flex flex-col bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 font-sans overflow-hidden transition-colors duration-300">
      {/* Background decoration */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-blue-500/10 dark:bg-blue-900/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 dark:bg-purple-900/20 blur-[120px] rounded-full pointer-events-none" />

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
            <button 
              onClick={() => { setCurrentScreen('settings'); setIsMobileMenuOpen(false); }}
              className={`flex items-center gap-4 px-4 py-4 rounded-xl transition-all ${currentScreen === 'settings' ? 'bg-neutral-900 text-white dark:bg-neutral-800 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-100 dark:hover:bg-neutral-800/50'}`}
            >
              <Settings size={20} /> Settings
            </button>
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
            onClick={() => setCurrentScreen('settings')}
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
            <button 
              onClick={() => setCurrentScreen('settings')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${currentScreen === 'settings' ? 'bg-neutral-900 text-white dark:bg-neutral-800 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50'}`}
            >
              <Settings size={16} /> Settings
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

      <main className="flex-1 overflow-y-auto w-full p-4 sm:p-6 md:p-12 flex flex-col items-center justify-start relative z-10 overscroll-y-contain [WebkitOverflowScrolling:touch]">
        <div className="w-full max-w-4xl relative">
          
          {currentScreen === 'home' && (
            <div ref={screenRef} className="bg-white/60 dark:bg-neutral-900/60 p-6 sm:p-10 md:p-16 rounded-3xl md:rounded-[2rem] border border-neutral-200/60 dark:border-neutral-800/60 shadow-2xl backdrop-blur-xl">
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
            <div ref={screenRef} className="bg-white/60 dark:bg-neutral-900/60 p-6 sm:p-10 md:p-16 rounded-3xl md:rounded-[2rem] border border-purple-200/50 dark:border-purple-800/20 shadow-2xl backdrop-blur-xl">
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
            <div ref={screenRef} className="bg-white/60 dark:bg-neutral-900/60 p-6 sm:p-10 md:p-16 rounded-3xl md:rounded-[2rem] border border-orange-200/50 dark:border-orange-800/20 shadow-2xl backdrop-blur-xl">
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
                  <input 
                    type="text" 
                    value={contactName}
                    onChange={(e) => setContactName(e.target.value)}
                    className="w-full bg-white dark:bg-neutral-950 border border-neutral-300 dark:border-neutral-800 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/50 transition-all" 
                    placeholder="John Doe" 
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wider mb-2">Message</label>
                  <textarea 
                    rows={4} 
                    value={contactMessage}
                    onChange={(e) => setContactMessage(e.target.value)}
                    className="w-full bg-white dark:bg-neutral-950 border border-neutral-300 dark:border-neutral-800 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/50 transition-all resize-none" 
                    placeholder="I'd love to learn more..." 
                  />
                </div>
                <button className="w-full bg-orange-500 hover:bg-orange-600 dark:hover:bg-orange-400 text-white font-bold py-3 px-4 rounded-xl transition-colors mt-4">
                  Send Message
                </button>
              </form>
            </div>
          )}

          {currentScreen === 'settings' && (
            <div ref={screenRef} className="bg-white/60 dark:bg-neutral-900/60 p-6 sm:p-10 md:p-16 rounded-3xl md:rounded-[2rem] border border-blue-200/50 dark:border-blue-800/20 shadow-2xl backdrop-blur-xl">
              <div className="h-16 w-16 bg-gradient-to-br from-blue-500/20 to-blue-600/10 rounded-2xl flex items-center justify-center mb-8 border border-blue-500/20 shadow-inner">
                <Settings className="text-blue-500 dark:text-blue-400" size={32} />
              </div>
              <h2 className="text-3xl md:text-5xl font-extrabold text-neutral-900 dark:text-white mb-4 md:mb-6 tracking-tight">Setup & Configure</h2>
              <p className="text-base md:text-lg text-neutral-600 dark:text-neutral-400 leading-relaxed mb-8 md:mb-10 max-w-2xl">
                Configure your API key and AI voice options here. Voice and language changes apply instantly! Changing the API key requires starting a new session.
              </p>
              
              <div className="space-y-6 max-w-full md:max-w-2xl">
                <div className="bg-neutral-50 dark:bg-neutral-950 p-6 rounded-2xl border border-neutral-200 dark:border-neutral-800">
                  <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                    OpenAI Secret Key
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="w-full bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all"
                    placeholder="sk-..."
                  />
                  <p className="text-[10px] sm:text-xs text-neutral-500 dark:text-neutral-500 mt-2">
                    Stored securely in your local browser storage. We never log or transmit this.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="bg-neutral-50 dark:bg-neutral-950 p-6 rounded-2xl border border-neutral-200 dark:border-neutral-800">
                    <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wider mb-3">Language</label>
                    <div className="relative">
                      <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        className="w-full bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all appearance-none cursor-pointer"
                      >
                        {LANGUAGES.map(lang => (
                          <option key={lang} value={lang}>{lang}</option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-neutral-500">
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path>
                        </svg>
                      </div>
                    </div>
                  </div>

                  <div className="bg-neutral-50 dark:bg-neutral-950 p-6 rounded-2xl border border-neutral-200 dark:border-neutral-800">
                    <label className="block text-xs font-bold text-neutral-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                      <Mic size={14} /> AI Voice
                    </label>
                    <div className="relative">
                      <select
                        value={voice}
                        onChange={(e) => setVoice(e.target.value)}
                        className="w-full bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded-xl px-4 py-3 text-neutral-900 dark:text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all appearance-none cursor-pointer"
                      >
                        {VOICES.map(v => (
                          <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-neutral-500">
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path>
                        </svg>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-4">
                  <button 
                    onClick={saveSettings}
                    disabled={!apiKey.trim()}
                    className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-neutral-400 disabled:cursor-not-allowed text-white font-bold py-3.5 px-6 rounded-xl transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2"
                  >
                    Save & Return to Home
                  </button>
                </div>
              </div>

            </div>
          )}

        </div>
      </main>
    </div>
  );
}
