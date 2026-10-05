import { useCallback, useEffect, useState } from 'react'
import Header from '../components/Header.jsx'
import VideoInfo from '../components/VideoInfo.jsx'
import AnalyzeButton from '../components/AnalyzeButton.jsx'
import LoadingState from '../components/LoadingState.jsx'
import ErrorState from '../components/ErrorState.jsx'
import VerdictView from '../components/VerdictView.jsx'
import { fetchVideoInfo, analyzeVideo } from '../lib/api.js'
import { parseVideoId } from '../lib/youtube.js'

const STATE = {
  LOADING: 'loading',
  UNSUPPORTED: 'unsupported',
  READY: 'ready',
  ANALYZING: 'analyzing',
  DONE: 'done',
  ERROR: 'error',
}

function getActiveTab() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
      resolve(null)
      return
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] || null))
  })
}

export default function Popup() {
  const [state, setState] = useState(STATE.LOADING)
  const [videoId, setVideoId] = useState(null)
  const [video, setVideo] = useState(null)
  const [commentsEnabled, setCommentsEnabled] = useState(true)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  /** Step 1-4: detect the current YouTube video and load its metadata. */
  const loadVideo = useCallback(async () => {
    setState(STATE.LOADING)
    setError(null)
    try {
      const tab = await getActiveTab()
      const id = tab?.url ? parseVideoId(tab.url) : null

      if (!id) {
        setVideoId(null)
        setVideo(null)
        setState(STATE.UNSUPPORTED)
        return
      }

      setVideoId(id)
      const info = await fetchVideoInfo(id)
      setVideo(info.video)
      setCommentsEnabled(info.commentsEnabled !== false)
      setState(STATE.READY)
    } catch (err) {
      setError(err)
      setState(STATE.ERROR)
    }
  }, [])

  useEffect(() => {
    loadVideo()
  }, [loadVideo])

  /** Step 5-14: ask the backend for the community verdict. */
  const runAnalysis = useCallback(async () => {
    if (!videoId) return
    setState(STATE.ANALYZING)
    setError(null)
    try {
      const data = await analyzeVideo(videoId)
      setResult(data)
      setState(STATE.DONE)
    } catch (err) {
      setError(err)
      setState(STATE.ERROR)
    }
  }, [videoId])

  // Retry the analysis when we already have video details, otherwise re-detect the tab.
  const retry = video ? runAnalysis : loadVideo

  return (
    <div className="flex h-[600px] flex-col bg-slate-50">
      <Header />

      <div className="sts-scroll flex-1 overflow-y-auto">
        {state === STATE.LOADING && (
          <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-slate-500">
            <svg viewBox="0 0 24 24" className="sts-spinner h-4 w-4 text-indigo-600" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
              <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            Reading the current tab...
          </div>
        )}

        {state === STATE.UNSUPPORTED && (
          <ErrorState
            title="No YouTube video here"
            message="SkipTheScroll only works on a YouTube watch page."
            hint="Open a tutorial, review or problem-solving video, then click the extension icon again."
            onRetry={loadVideo}
            retryLabel="Check again"
          />
        )}

        {state === STATE.ERROR && (
          <ErrorState
            error={error}
            onRetry={retry}
            onReset={loadVideo}
          />
        )}

        {(state === STATE.READY || state === STATE.ANALYZING || state === STATE.DONE) && video && (
          <>
            <VideoInfo video={video} commentsEnabled={commentsEnabled} />

            {state === STATE.READY && (
              <AnalyzeButton
                onClick={runAnalysis}
                label={commentsEnabled ? 'Analyze Comments' : 'Check comments anyway'}
              />
            )}

            {state === STATE.ANALYZING && <LoadingState videoTitle={video.title} />}

            {state === STATE.DONE && (
              <VerdictView
                data={result}
                busy={false}
                onReanalyze={runAnalysis}
                onReset={loadVideo}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
