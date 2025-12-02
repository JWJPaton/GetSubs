import React, { useState, useRef } from 'react';
import { createWorker } from 'tesseract.js';
import { Upload, Play, Download, Settings, AlertCircle } from 'lucide-react';

export default function SubtitleExtractor() {
  const [video, setVideo] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [ocrProgress, setOcrProgress] = useState('');
  const [subtitles, setSubtitles] = useState([]);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState({
    frameInterval: 500,
    subtitleRegionY: 80,
    subtitleRegionHeight: 20,
    minConfidence: 60,
    similarityThreshold: 0.85,
    preprocessImage: true,
    language: 'eng'
  });
  const [showSettings, setShowSettings] = useState(false);
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const addLog = (message) => {
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString()}: ${message}`]);
  };

  const handleVideoUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setVideo(url);
      setSubtitles([]);
      setLogs([]);
      addLog(`Video loaded: ${file.name}`);
    }
  };

  const stringSimilarity = (str1, str2) => {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = (s1, s2) => {
      const costs = [];
      for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
          if (i === 0) {
            costs[j] = j;
          } else if (j > 0) {
            let newValue = costs[j - 1];
            if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
              newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
            }
            costs[j - 1] = lastValue;
            lastValue = newValue;
          }
        }
        if (i > 0) costs[s2.length] = lastValue;
      }
      return costs[s2.length];
    };
    
    return (longer.length - editDistance(longer, shorter)) / longer.length;
  };

  const cleanText = (text) => {
    return text
      .replace(/[^\w\s.,!?'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const preprocessCanvas = (canvas, ctx) => {
    if (!settings.preprocessImage) return;
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    // Convert to grayscale and increase contrast
    for (let i = 0; i < data.length; i += 4) {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      
      // Increase contrast for subtitle text (typically white on dark background)
      const enhanced = avg > 128 ? 255 : 0;
      
      data[i] = enhanced;
      data[i + 1] = enhanced;
      data[i + 2] = enhanced;
    }
    
    ctx.putImageData(imageData, 0, 0);
  };

  const formatTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  };

  const processVideo = async () => {
    if (!videoRef.current) return;

    setIsProcessing(true);
    setProgress(0);
    setSubtitles([]);
    addLog('Initializing Tesseract OCR engine...');

    // Create Tesseract worker
    const worker = await createWorker(settings.language, 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          setOcrProgress(`OCR: ${Math.round(m.progress * 100)}%`);
        }
      }
    });

    // Configure Tesseract for subtitle text
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,!?\'-',
      tessedit_pageseg_mode: '6', // Assume uniform block of text
    });

    addLog('OCR engine initialized');

    const videoElement = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const duration = videoElement.duration;
    
    const extractedSubs = [];
    let currentTime = 0;
    let lastText = '';
    let lastStartTime = 0;
    let frameCount = 0;

    addLog(`Processing video (duration: ${duration.toFixed(2)}s)...`);

    while (currentTime < duration) {
      videoElement.currentTime = currentTime;
      
      await new Promise(resolve => {
        videoElement.onseeked = resolve;
      });

      const videoWidth = videoElement.videoWidth;
      const videoHeight = videoElement.videoHeight;
      canvas.width = videoWidth;
      canvas.height = videoHeight;

      // Draw full frame
      ctx.drawImage(videoElement, 0, 0, videoWidth, videoHeight);

      // Extract subtitle region
      const regionY = Math.floor((settings.subtitleRegionY / 100) * videoHeight);
      const regionHeight = Math.floor((settings.subtitleRegionHeight / 100) * videoHeight);
      
      // Create a temporary canvas for the subtitle region
      const regionCanvas = document.createElement('canvas');
      regionCanvas.width = videoWidth;
      regionCanvas.height = regionHeight;
      const regionCtx = regionCanvas.getContext('2d');
      
      regionCtx.drawImage(canvas, 0, regionY, videoWidth, regionHeight, 0, 0, videoWidth, regionHeight);
      
      // Preprocess for better OCR
      if (settings.preprocessImage) {
        preprocessCanvas(regionCanvas, regionCtx);
      }
      
      // Perform OCR
      try {
        const { data: { text, confidence } } = await worker.recognize(regionCanvas);
        const cleanedText = cleanText(text);

        if (cleanedText && confidence > settings.minConfidence) {
          const similarity = stringSimilarity(cleanedText, lastText);
          
          if (similarity < settings.similarityThreshold) {
            // New subtitle detected
            if (lastText) {
              extractedSubs.push({
                start: lastStartTime,
                end: currentTime,
                text: lastText,
                confidence: confidence
              });
              addLog(`[${formatTime(lastStartTime)} -> ${formatTime(currentTime)}] "${lastText}"`);
            }
            lastText = cleanedText;
            lastStartTime = currentTime;
          }
        } else if (lastText && (!cleanedText || confidence <= settings.minConfidence)) {
          // Subtitle disappeared
          extractedSubs.push({
            start: lastStartTime,
            end: currentTime,
            text: lastText,
            confidence: confidence
          });
          addLog(`[${formatTime(lastStartTime)} -> ${formatTime(currentTime)}] "${lastText}"`);
          lastText = '';
        }
      } catch (error) {
        addLog(`OCR error at ${currentTime.toFixed(2)}s: ${error.message}`);
      }

      currentTime += settings.frameInterval / 1000;
      frameCount++;
      setProgress((currentTime / duration) * 100);
    }

    // Handle final subtitle if still active
    if (lastText) {
      extractedSubs.push({
        start: lastStartTime,
        end: duration,
        text: lastText,
        confidence: 0
      });
      addLog(`[${formatTime(lastStartTime)} -> ${formatTime(duration)}] "${lastText}"`);
    }

    await worker.terminate();
    setSubtitles(extractedSubs);
    setIsProcessing(false);
    setOcrProgress('');
    addLog(`✓ Extraction complete! Found ${extractedSubs.length} subtitles.`);
  };

  const downloadSRT = () => {
    let srt = '';
    subtitles.forEach((sub, index) => {
      srt += `${index + 1}\n`;
      srt += `${formatTime(sub.start)} --> ${formatTime(sub.end)}\n`;
      srt += `${sub.text}\n\n`;
    });

    const blob = new Blob([srt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'subtitles.srt';
    a.click();
    URL.revokeObjectURL(url);
    addLog('SRT file downloaded');
  };

  const downloadVTT = () => {
    let vtt = 'WEBVTT\n\n';
    subtitles.forEach((sub, index) => {
      const startVTT = formatTime(sub.start).replace(',', '.');
      const endVTT = formatTime(sub.end).replace(',', '.');
      vtt += `${index + 1}\n`;
      vtt += `${startVTT} --> ${endVTT}\n`;
      vtt += `${sub.text}\n\n`;
    });

    const blob = new Blob([vtt], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'subtitles.vtt';
    a.click();
    URL.revokeObjectURL(url);
    addLog('WebVTT file downloaded');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="bg-white rounded-lg shadow-2xl overflow-hidden">
          <div className="bg-gradient-to-r from-blue-600 to-purple-600 p-6">
            <h1 className="text-3xl font-bold text-white">Burnt-in Subtitle Extractor</h1>
            <p className="text-blue-100 mt-2">Extract subtitles from video using Tesseract.js OCR</p>
          </div>

          <div className="p-6 space-y-6">
            {/* Setup Instructions */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <h3 className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
                <AlertCircle className="h-5 w-5" />
                Setup Instructions
              </h3>
              <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
                <li>Install dependencies: <code className="bg-blue-100 px-2 py-1 rounded">npm install tesseract.js lucide-react</code></li>
                <li>This code is ready to use in your React environment (Next.js, Create React App, Vite, etc.)</li>
                <li>Make sure you have Tailwind CSS configured for styling</li>
              </ol>
            </div>

            {/* Video Upload */}
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-500 transition-colors">
              <input
                type="file"
                accept="video/*"
                onChange={handleVideoUpload}
                className="hidden"
                id="video-upload"
              />
              <label htmlFor="video-upload" className="cursor-pointer">
                <Upload className="mx-auto h-12 w-12 text-gray-400" />
                <p className="mt-2 text-sm text-gray-600">
                  Click to upload video or drag and drop
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  MP4, WebM, AVI, or any video format
                </p>
              </label>
            </div>

            {/* Video Preview */}
            {video && (
              <div className="space-y-4">
                <video
                  ref={videoRef}
                  src={video}
                  controls
                  className="w-full rounded-lg shadow-lg"
                />
                <canvas ref={canvasRef} className="hidden" />
              </div>
            )}

            {/* Settings */}
            <div className="bg-gray-50 rounded-lg p-4">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="flex items-center gap-2 text-gray-700 font-semibold"
              >
                <Settings className="h-5 w-5" />
                Advanced Settings
              </button>
              
              {showSettings && (
                <div className="mt-4 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Frame Interval (ms): {settings.frameInterval}
                    </label>
                    <input
                      type="range"
                      min="100"
                      max="2000"
                      step="100"
                      value={settings.frameInterval}
                      onChange={(e) => setSettings({...settings, frameInterval: parseInt(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500 mt-1">How often to sample frames. Lower = more accurate but slower.</p>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Subtitle Region Y Position (%): {settings.subtitleRegionY}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={settings.subtitleRegionY}
                      onChange={(e) => setSettings({...settings, subtitleRegionY: parseInt(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500 mt-1">Top position of subtitle region. UK Teletext typically 80-85%.</p>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Subtitle Region Height (%): {settings.subtitleRegionHeight}
                    </label>
                    <input
                      type="range"
                      min="5"
                      max="50"
                      value={settings.subtitleRegionHeight}
                      onChange={(e) => setSettings({...settings, subtitleRegionHeight: parseInt(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500 mt-1">Height of the region to scan for subtitles.</p>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Minimum OCR Confidence (%): {settings.minConfidence}
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={settings.minConfidence}
                      onChange={(e) => setSettings({...settings, minConfidence: parseInt(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500 mt-1">Minimum confidence to accept OCR results.</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Text Similarity Threshold: {settings.similarityThreshold.toFixed(2)}
                    </label>
                    <input
                      type="range"
                      min="0.5"
                      max="1"
                      step="0.05"
                      value={settings.similarityThreshold}
                      onChange={(e) => setSettings({...settings, similarityThreshold: parseFloat(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-gray-500 mt-1">How similar text must be to be considered the same subtitle.</p>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="preprocess"
                      checked={settings.preprocessImage}
                      onChange={(e) => setSettings({...settings, preprocessImage: e.target.checked})}
                      className="rounded"
                    />
                    <label htmlFor="preprocess" className="text-sm font-medium text-gray-700">
                      Preprocess images (convert to high contrast B&W)
                    </label>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      OCR Language
                    </label>
                    <select
                      value={settings.language}
                      onChange={(e) => setSettings({...settings, language: e.target.value})}
                      className="w-full border border-gray-300 rounded px-3 py-2"
                    >
                      <option value="eng">English</option>
                      <option value="fra">French</option>
                      <option value="spa">Spanish</option>
                      <option value="deu">German</option>
                      <option value="ita">Italian</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Process Button */}
            {video && (
              <button
                onClick={processVideo}
                disabled={isProcessing}
                className="w-full bg-gradient-to-r from-blue-600 to-purple-600 text-white py-3 rounded-lg font-semibold hover:from-blue-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    Processing... {progress.toFixed(1)}%
                    {ocrProgress && <span className="text-sm">({ocrProgress})</span>}
                  </>
                ) : (
                  <>
                    <Play className="h-5 w-5" />
                    Extract Subtitles with OCR
                  </>
                )}
              </button>
            )}

            {/* Progress Bar */}
            {isProcessing && (
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}

            {/* Subtitles Display */}
            {subtitles.length > 0 && (
              <div className="space-y-4">
                <div className="flex gap-2">
                  <button
                    onClick={downloadSRT}
                    className="flex-1 bg-green-600 text-white py-2 rounded-lg font-semibold hover:bg-green-700 flex items-center justify-center gap-2"
                  >
                    <Download className="h-5 w-5" />
                    Download SRT
                  </button>
                  <button
                    onClick={downloadVTT}
                    className="flex-1 bg-purple-600 text-white py-2 rounded-lg font-semibold hover:bg-purple-700 flex items-center justify-center gap-2"
                  >
                    <Download className="h-5 w-5" />
                    Download WebVTT
                  </button>
                </div>

                <div className="bg-gray-50 rounded-lg p-4 max-h-96 overflow-y-auto">
                  <h3 className="font-semibold text-gray-800 mb-2">
                    Extracted Subtitles ({subtitles.length})
                  </h3>
                  {subtitles.map((sub, index) => (
                    <div key={index} className="border-b border-gray-200 py-2">
                      <div className="flex justify-between items-center">
                        <div className="text-xs text-gray-500">
                          {formatTime(sub.start)} → {formatTime(sub.end)}
                        </div>
                        {sub.confidence > 0 && (
                          <div className="text-xs text-gray-400">
                            {sub.confidence.toFixed(0)}% confidence
                          </div>
                        )}
                      </div>
                      <div className="text-sm text-gray-800 mt-1">{sub.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Logs */}
            {logs.length > 0 && (
              <div className="bg-gray-900 rounded-lg p-4 max-h-64 overflow-y-auto">
                <h3 className="font-semibold text-gray-100 mb-2">Processing Log</h3>
                <div className="space-y-0.5">
                  {logs.map((log, index) => (
                    <div key={index} className="text-xs text-green-400 font-mono">
                      {log}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
