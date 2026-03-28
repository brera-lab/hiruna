import { useState } from 'react'
import { useTaskStore } from './useTaskStore'
import AddTaskForm from './components/AddTaskForm'
import TaskItem from './components/TaskItem'
import type { Priority } from './types'

type Filter = 'all' | 'active' | 'completed'

const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'active', label: '未完了' },
  { value: 'completed', label: '完了済み' },
]

export default function App() {
  const { tasks, addTask, toggleTask, deleteTask } = useTaskStore()
  const [filter, setFilter] = useState<Filter>('all')

  function handleAdd(text: string, priority: Priority) {
    addTask(text, priority)
  }

  const filtered = tasks.filter((t) => {
    if (filter === 'active') return !t.completed
    if (filter === 'completed') return t.completed
    return true
  })

  const activeCount = tasks.filter((t) => !t.completed).length

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 py-8">
        {/* Header */}
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-indigo-600 tracking-tight">Hiruna</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {activeCount > 0 ? `${activeCount} 件のタスクが残っています` : 'すべて完了！'}
          </p>
        </header>

        {/* Add form */}
        <AddTaskForm onAdd={handleAdd} />

        {/* Filter tabs */}
        <div className="flex gap-1 mt-5 mb-3 bg-gray-100 p-1 rounded-xl">
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === f.value ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Task list */}
        <div className="flex flex-col gap-2">
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">
              タスクがありません
            </div>
          ) : (
            filtered.map((task) => (
              <TaskItem
                key={task.id}
                task={task}
                onToggle={toggleTask}
                onDelete={deleteTask}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
