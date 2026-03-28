import { useState } from 'react'
import type { Priority } from '../types'

interface Props {
  onAdd: (text: string, priority: Priority) => void
}

const priorities: { value: Priority; label: string }[] = [
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
]

export default function AddTaskForm({ onAdd }: Props) {
  const [text, setText] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    onAdd(trimmed, priority)
    setText('')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-4 bg-white rounded-2xl shadow-sm">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="新しいタスクを入力..."
        className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
      />
      <div className="flex gap-2 items-center justify-between">
        <div className="flex gap-2">
          {priorities.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPriority(p.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                priority === p.value
                  ? p.value === 'high'
                    ? 'bg-red-500 text-white'
                    : p.value === 'medium'
                    ? 'bg-yellow-400 text-white'
                    : 'bg-green-500 text-white'
                  : 'bg-gray-100 text-gray-500'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          type="submit"
          className="px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 active:scale-95 transition-all"
        >
          追加
        </button>
      </div>
    </form>
  )
}
