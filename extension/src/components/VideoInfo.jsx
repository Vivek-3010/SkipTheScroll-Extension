import { useState } from 'react'
import { fallbackThumbnail, formatCount } from '../lib/youtube.js'

export default function VideoInfo({ video, commentsEnabled = true }) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const thumbnail = !thumbFailed ? video.thumbnail || fallbackThumbnail(video.id) : fallbackThumbnail(video.id)

  return (
    <section className="border-b border-slate-200 bg-white px-4 py-3">
      <div className="flex gap-3">
        <img
          src={thumbnail || ''}
          onError={() => setThumbFailed(true)}
          alt=""
          width={112}
          height={63}
          className="h-[63px] w-[112px] shrink-0 rounded-lg bg-slate-200 object-cover ring-1 ring-slate-900/5"
        />

        <div className="min-w-0 flex-1">
          <h2 className="sts-clamp-2 text-[13px] font-semibold leading-snug text-slate-900">
            {video.title || 'Unknown video'}
          </h2>
          <p className="mt-0.5 truncate text-[11px] text-slate-500">{video.channel || 'Unknown channel'}</p>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-slate-500">
            <span>{formatCount(video.viewCount)} views</span>
            <span className="text-slate-300">|</span>
            <span className={commentsEnabled ? '' : 'font-medium text-amber-700'}>
              {commentsEnabled
                ? `${formatCount(video.commentCount)} comments`
                : 'No comments'}
            </span>
            {video.likeCount > 0 && (
              <>
                <span className="text-slate-300">|</span>
                <span>{formatCount(video.likeCount)} likes</span>
              </>
            )}
          </div>
        </div>
      </div>

      {video.url && (
        <a
          href={video.url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-[10px] font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
        >
          Open video on YouTube
        </a>
      )}
    </section>
  )
}
