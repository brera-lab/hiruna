export type Priority = 'high' | 'medium' | 'low'

export interface Task {
  id: string
  text: string
  completed: boolean
  priority: Priority
  createdAt: number
}
