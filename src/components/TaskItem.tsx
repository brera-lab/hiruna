import type { Task } from '../types'

interface Props {
  task: Task
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}

const priorityStyles = {
  high: 'border-l-4 border-red-400',
  medium: 'border-l-4 border-yellow-400',
  low: 'border-l-4 border-green-400',
}

const priorityBadge = {
  high: 'bg-red-100 text-red-600',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-green-100 text-green-700',
}

const priorityLabel = { high: '高', medium: '中', low: '低' }

export default function TaskItem({ task, onToggle, onDelete }: Props) {
  return (
    <div
      className={`flex items-center gap-3 bg-white rounded-2xl shadow-sm px-4 py-3 ${priorityStyles[task.priority]}`}
    >
      <button
        onClick={() => onToggle(task.id)}
        className={`flex-shrink-0 w-6 h-6 rounded-full border-2 transition-colors flex items-center justify-center ${
          task.completed
            ? 'bg-indigo-500 border-indigo-500'
            : 'border-gray-300 hover:border-indigo-400'
        }`}
        aria-label={task.completed ? '未完了に戻す' : '完了にする'}
      >
        {task.completed && (
          <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <span className={`flex-1 text-sm ${task.completed ? 'line-through text-gray-400' : 'text-gray-800'}`}>
        {task.text}
      </span>

      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${priorityBadge[task.priority]}`}>
        {priorityLabel[task.priority]}
      </span>

      <button
        onClick={() => onDelete(task.id)}
        className="flex-shrink-0 text-gray-300 hover:text-red-400 transition-colors"
        aria-label="削除"
      >
        <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  )
}
