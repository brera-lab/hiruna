import { useState, useEffect, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { AppStore } from '../store';
import type { Task, TimeBlock, FixedBlock } from '../types';
import { AREA_STYLE, TIME_BLOCKS, TIME_BLOCK_INFO, FIXED_BLOCK_TYPE_INFO } from '../types';
import { todayLabel, getISOWeek, formatWeek, formatMinutes, getToday } from '../utils';

interface Props {
  store: AppStore;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Area colors as hex for inline styles (Tailwind can't purge dynamic classes)
const AREA_HEX: Record<string, string> = {
  '仕事・本業': '#3b82f6',
  '副業・PJ': '#f97316',
  'Vyvo・素質論': '#a855f7',
  '家族・プライベート': '#22c55e',
  'トライアスロン・健康': '#ef4444',
};

const BLOCK_ORDER: Record<string, number> = {
  golden: 0, morning: 1, afternoon: 2, evening: 3,
};

// Default start minute for each timeBlock (to avoid jumping backward)
const BLOCK_DEFAULT_MIN: Record<string, number> = {
  golden: 480,   // 8:00
  morning: 660,  // 11:00
  afternoon: 780,// 13:00
  evening: 990,  // 16:30
};

interface TimelineSlot {
  startMin: number;
  endMin: number;
  kind: 'task' | 'fixed';
  task?: Task;
  fixed?: FixedBlock;
  completed: boolean; // task completed today / fixed block manually marked done
  overdue: boolean;   // fixed block: time has passed but not yet manually done
}

// Fixed block is "overdue" when current time has passed its expected end time but it's not manually done
function isFixedBlockOverdue(f: FixedBlock, currentMin: number, isDone: boolean): boolean {
  if (isDone) return false;
  if (!f.timeBlock) return false;
  const blockStart = BLOCK_DEFAULT_MIN[f.timeBlock] ?? 0;
  return currentMin > blockStart + f.minutes;
}

function buildTimeline(
  tasks: Task[],
  fixedBlocks: FixedBlock[],
  startMin: number,
  endMin: number,
  completedTodayIds: Set<string>,
  completedFixedIds: Set<string>,
  currentMin: number,
): TimelineSlot[] {
  type Item = {
    blockOrder: number;
    subOrder: number;
    minutes: number;
    kind: 'task' | 'fixed';
    task?: Task;
    fixed?: FixedBlock;
    timeBlock: string | null;
  };

  const items: Item[] = [
    ...tasks
      .filter((t) => !completedTodayIds.has(t.id))
      .map((t) => ({
        blockOrder: t.timeBlock ? BLOCK_ORDER[t.timeBlock] ?? 4 : 4,
        subOrder: t.sortOrder,
        minutes: t.estimatedMinutes,
        kind: 'task' as const,
        task: t,
        timeBlock: t.timeBlock,
      })),
    ...fixedBlocks
      .filter((f) => !completedFixedIds.has(f.id))
      .map((f) => ({
        blockOrder: f.timeBlock ? BLOCK_ORDER[f.timeBlock] ?? 4 : 4,
        subOrder: f.createdAt,
        minutes: f.minutes,
        kind: 'fixed' as const,
        fixed: f,
        timeBlock: f.timeBlock,
      })),
  ].sort((a, b) => {
    if (a.blockOrder !== b.blockOrder) return a.blockOrder - b.blockOrder;
    // fixed blocks first within same timeBlock
    if (a.kind !== b.kind) return a.kind === 'fixed' ? -1 : 1;
    return a.subOrder - b.subOrder;
  });

  const slots: TimelineSlot[] = [];
  let cursor = startMin;

  for (const item of items) {
    // If timeBlock has a default start that's later than cursor, advance cursor
    if (item.timeBlock && BLOCK_DEFAULT_MIN[item.timeBlock]) {
      const blockStart = BLOCK_DEFAULT_MIN[item.timeBlock];
      if (blockStart > cursor) cursor = blockStart;
    }
    if (cursor >= endMin) break;

    const slotEnd = Math.min(cursor + item.minutes, endMin);
    const isCompleted =
      item.kind === 'task'
        ? completedTodayIds.has(item.task?.id ?? '')
        : completedFixedIds.has(item.fixed?.id ?? '');
    const isOverdue =
      item.kind === 'fixed'
        ? isFixedBlockOverdue(item.fixed!, currentMin, completedFixedIds.has(item.fixed?.id ?? ''))
        : false;

    slots.push({
      startMin: cursor,
      endMin: slotEnd,
      kind: item.kind,
      task: item.task,
      fixed: item.fixed,
      completed: isCompleted,
      overdue: isOverdue,
    });
    cursor = slotEnd;
  }

  return slots;
}

// ── Timeline widget ───────────────────────────────────────────────────────────
function TimelineWidget({
  store,
  currentMin,
  onNavigateTasks,
}: {
  store: AppStore;
  currentMin: number;
  onNavigateTasks: () => void;
}) {
  const { state, setEndTime, getTodayTasks, toggleFixedBlockCompletion, isFixedBlockCompletedToday } = store;
  const [editingEnd, setEditingEnd] = useState(false);
  const [endInput, setEndInput] = useState(state.endTimeToday);

  const today = getToday();
  const endMin = timeToMinutes(state.endTimeToday);
  const remainingMin = Math.max(0, endMin - currentMin);

  const todayTasks = getTodayTasks();
  // IDs of tasks completed today
  const completedTodayIds = new Set(
    todayTasks.filter((t) => t.completedAt === today).map((t) => t.id),
  );
  // Only unfinished tasks count toward the budget
  const incompleteTasks = todayTasks.filter((t) => !completedTodayIds.has(t.id));
  const taskTotal = incompleteTasks.reduce((s, t) => s + t.estimatedMinutes, 0);

  // Fixed blocks: split by manual completion (resets each day)
  const completedFixedIds = new Set(
    state.fixedBlocks.filter((f) => isFixedBlockCompletedToday(f.id)).map((f) => f.id),
  );
  const remainingFixedBlocks = state.fixedBlocks.filter((f) => !completedFixedIds.has(f.id));
  const doneFixedBlocks      = state.fixedBlocks.filter((f) =>  completedFixedIds.has(f.id));
  const remainingFixedTotal  = remainingFixedBlocks.reduce((s, f) => s + f.minutes, 0);

  const availableMin = Math.max(0, remainingMin - remainingFixedTotal);
  const overMin = taskTotal - availableMin;

  const timeline = buildTimeline(
    incompleteTasks, remainingFixedBlocks, currentMin, endMin,
    completedTodayIds, completedFixedIds, currentMin,
  );
  const totalSpan = Math.max(1, endMin - currentMin);

  function saveEndTime() {
    setEndTime(endInput);
    setEditingEnd(false);
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm mb-4 overflow-hidden">
      {/* Header row */}
      <div className="px-4 pt-4 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-mono font-bold text-gray-800">{minutesToHHMM(currentMin)}</span>
          <span className="text-xs text-gray-400">現在時刻</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-400">終了</span>
          {editingEnd ? (
            <div className="flex items-center gap-1">
              <input
                type="time"
                value={endInput}
                onChange={(e) => setEndInput(e.target.value)}
                className="border border-indigo-300 rounded-lg px-2 py-1 text-sm font-mono w-24 focus:outline-none"
                autoFocus
                onBlur={saveEndTime}
                onKeyDown={(e) => e.key === 'Enter' && saveEndTime()}
              />
            </div>
          ) : (
            <button
              onClick={() => { setEndInput(state.endTimeToday); setEditingEnd(true); }}
              className="text-sm font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-1 rounded-lg"
            >
              {state.endTimeToday}
            </button>
          )}
        </div>
      </div>

      {/* Remaining time breakdown */}
      <div className="px-4 pb-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">残り時間</span>
            <span className="font-bold text-gray-800">{formatMinutes(remainingMin)}</span>
          </div>
          {/* Done fixed blocks (grayed, strikethrough) */}
          {doneFixedBlocks.map((f) => (
            <div key={f.id} className="flex items-center justify-between text-xs pl-3 opacity-40">
              <span className="text-gray-400 line-through">
                {FIXED_BLOCK_TYPE_INFO[f.type].icon} {f.title}
              </span>
              <span className="text-gray-400 line-through">−{formatMinutes(f.minutes)}</span>
            </div>
          ))}
          {/* Remaining fixed blocks */}
          {remainingFixedBlocks.map((f) => (
            <div key={f.id} className="flex items-center justify-between text-xs pl-3">
              <span className="text-gray-400">
                {FIXED_BLOCK_TYPE_INFO[f.type].icon} {f.title}
              </span>
              <span className="text-gray-400">−{formatMinutes(f.minutes)}</span>
            </div>
          ))}
          <div className="border-t border-gray-100 mt-1 pt-1 flex items-center justify-between text-sm">
            <span className="text-gray-600 font-medium">使える時間</span>
            <span className={`font-bold ${availableMin < taskTotal ? 'text-red-500' : 'text-indigo-600'}`}>
              {formatMinutes(availableMin)}
            </span>
          </div>
        </div>

        {/* Task total vs available */}
        <div className="mt-2 pt-2 border-t border-gray-100">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-gray-500">タスク見積もり合計</span>
            <span className="font-medium text-gray-700">{formatMinutes(taskTotal)}</span>
          </div>
          {overMin > 0 ? (
            <div className="flex items-center gap-1.5 bg-red-50 rounded-lg px-2.5 py-1.5">
              <span className="text-red-500 text-sm">⚠️</span>
              <span className="text-xs text-red-600 font-medium">
                {formatMinutes(overMin)} オーバーしています
              </span>
            </div>
          ) : taskTotal > 0 ? (
            <div className="flex items-center gap-1.5 bg-green-50 rounded-lg px-2.5 py-1.5">
              <span className="text-xs text-green-600 font-medium">
                ✓ あと {formatMinutes(availableMin - taskTotal)} 余裕あり
              </span>
            </div>
          ) : (
            <div className="text-xs text-gray-400 text-center py-1">
              タスクがありません —{' '}
              <button onClick={onNavigateTasks} className="text-indigo-500 underline">追加する</button>
            </div>
          )}
        </div>
      </div>

      {/* Visual horizontal bar */}
      {timeline.length > 0 && (
        <div className="px-4 pb-2">
          <div className="flex h-5 rounded-full overflow-hidden bg-gray-100 gap-px">
            {timeline.map((slot, i) => {
              const widthPct = ((slot.endMin - slot.startMin) / totalSpan) * 100;
              let color = '#d1d5db'; // gray for fixed / completed
              if (!slot.completed && slot.kind === 'task' && slot.task?.area) {
                color = AREA_HEX[slot.task.area] ?? '#6366f1';
              }
              return (
                <div
                  key={i}
                  style={{
                    width: `${widthPct}%`,
                    backgroundColor: color,
                    opacity: slot.completed ? 0.3 : slot.kind === 'fixed' ? 0.5 : 0.85,
                  }}
                  className="h-full flex-shrink-0"
                  title={slot.task?.title ?? slot.fixed?.title}
                />
              );
            })}
            {/* Remaining empty space */}
            <div className="flex-1 bg-gray-100" />
          </div>
          <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
            <span>{minutesToHHMM(currentMin)}</span>
            <span>{state.endTimeToday}</span>
          </div>
        </div>
      )}

      {/* Sequential timeline list */}
      {timeline.length > 0 && (
        <div className="border-t border-gray-50">
          <div className="px-3 py-1.5 flex items-center gap-2">
            <div className="flex-shrink-0 w-1 h-4 bg-red-500 rounded-full" />
            <span className="text-xs font-bold text-red-500">{minutesToHHMM(currentMin)} 現在</span>
          </div>
          <div className="flex flex-col">
            {timeline.map((slot, i) => {
              const isFixed = slot.kind === 'fixed';
              const isDone = slot.completed;
              const isOverdue = slot.overdue;
              const color = isDone || isFixed
                ? '#9ca3af'
                : slot.task?.area ? AREA_HEX[slot.task.area] : '#6366f1';
              const icon = isFixed
                ? FIXED_BLOCK_TYPE_INFO[slot.fixed?.type ?? 'other'].icon
                : isDone ? '✓' : '';
              const title = slot.task?.title ?? slot.fixed?.title ?? '';
              const duration = slot.endMin - slot.startMin;

              return (
                <div
                  key={i}
                  className={`flex items-center gap-2 px-3 py-2 border-t border-gray-50 ${isDone ? 'opacity-40' : ''}`}
                >
                  {/* Time + color dot */}
                  <div className="flex-shrink-0 w-20 text-right">
                    <span className="text-[10px] text-gray-400 font-mono">
                      {minutesToHHMM(slot.startMin)}〜{minutesToHHMM(slot.endMin)}
                    </span>
                  </div>
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <div className="flex-1 min-w-0">
                    <span className={`text-xs font-medium ${isDone ? 'line-through text-gray-400' : isFixed ? 'text-gray-500' : 'text-gray-800'}`}>
                      {icon} {title}
                    </span>
                    {isOverdue && (
                      <span className="ml-1.5 text-[10px] bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded font-medium">
                        ⚠️ 後回し
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-gray-400 flex-shrink-0">
                    {formatMinutes(duration)}
                  </span>
                  {/* Manual done toggle for fixed blocks */}
                  {isFixed && (
                    <button
                      onClick={() => toggleFixedBlockCompletion(slot.fixed!.id)}
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                        isDone ? 'bg-gray-400 border-gray-400' : 'border-gray-300 hover:border-gray-400'
                      }`}
                      title={isDone ? '未完了に戻す' : '済みにする'}
                    >
                      {isDone && (
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="px-3 py-1.5 flex items-center gap-2 border-t border-gray-100">
            <div className="flex-shrink-0 w-1 h-4 bg-gray-300 rounded-full" />
            <span className="text-xs text-gray-400">{state.endTimeToday} 終了</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sortable task row ─────────────────────────────────────────────────────────
function SortableTaskRow({
  task,
  onToggle,
  isCompletedToday,
}: {
  task: Task;
  onToggle: () => void;
  isCompletedToday: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const done = isCompletedToday;
  const areaStyle = task.area ? AREA_STYLE[task.area] : null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white rounded-xl shadow-sm px-3 py-2.5 flex items-center gap-2 ${
        areaStyle ? `border-l-4 ${areaStyle.border}` : 'border-l-4 border-gray-200'
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="text-gray-300 hover:text-gray-500 flex-shrink-0 touch-none"
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 6a2 2 0 110-4 2 2 0 010 4zm0 8a2 2 0 110-4 2 2 0 010 4zm0 8a2 2 0 110-4 2 2 0 010 4zm8-16a2 2 0 110-4 2 2 0 010 4zm0 8a2 2 0 110-4 2 2 0 010 4zm0 8a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>
      <button
        onClick={onToggle}
        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
          done ? 'bg-indigo-500 border-indigo-500' : 'border-gray-300'
        }`}
      >
        {done && (
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate ${done ? 'line-through text-gray-400' : 'text-gray-800'}`}>
          {task.taskType === 'meeting' && <span className="text-xs mr-1">📅</span>}
          {task.title}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          {task.area && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full text-white font-medium ${AREA_STYLE[task.area].badge}`}>
              {task.area}
            </span>
          )}
          <span className="text-xs text-gray-400">{formatMinutes(task.estimatedMinutes)}</span>
          {task.isCarryOver && (
            <span className="text-[10px] bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded font-medium">繰り越し</span>
          )}
          {task.pomodoroCount > 0 && (
            <span className="text-xs text-orange-400">🍅×{task.pomodoroCount}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Meeting quick-add ─────────────────────────────────────────────────────────
interface MeetingEntry {
  title: string;
  estimatedMinutes: number;
  timeBlock: Exclude<TimeBlock, 'golden'>;
}

function MeetingModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (meetings: { title: string; estimatedMinutes: number; timeBlock: TimeBlock }[]) => void;
}) {
  const [entries, setEntries] = useState<MeetingEntry[]>([
    { title: '', estimatedMinutes: 60, timeBlock: 'morning' },
  ]);

  function update(i: number, field: keyof MeetingEntry, value: string | number) {
    setEntries((e) => e.map((entry, idx) => idx === i ? { ...entry, [field]: value } : entry));
  }

  function submit() {
    const valid = entries.filter((e) => e.title.trim());
    if (!valid.length) return;
    onAdd(valid.map((e) => ({ ...e, title: e.title.trim() })));
    onClose();
  }

  const nonGolden = (['morning', 'afternoon', 'evening'] as const);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-t-3xl w-full max-w-lg p-5 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold text-gray-800 mb-1">ミーティングを追加</h2>
        <p className="text-xs text-gray-400 mb-4">複数まとめて登録できます</p>
        <div className="flex flex-col gap-3 mb-4">
          {entries.map((entry, i) => (
            <div key={i} className="bg-gray-50 rounded-xl p-3">
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="text"
                  value={entry.title}
                  onChange={(e) => update(i, 'title', e.target.value)}
                  placeholder="ミーティング名"
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none"
                  autoFocus={i === 0}
                />
                {entries.length > 1 && (
                  <button onClick={() => setEntries((e) => e.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">✕</button>
                )}
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-gray-500 mb-1 block">時間（分）</label>
                  <input
                    type="number"
                    value={entry.estimatedMinutes}
                    onChange={(e) => update(i, 'estimatedMinutes', Number(e.target.value))}
                    min={5} step={15}
                    className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm bg-white"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-gray-500 mb-1 block">ブロック</label>
                  <select
                    value={entry.timeBlock}
                    onChange={(e) => update(i, 'timeBlock', e.target.value as Exclude<TimeBlock, 'golden'>)}
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white"
                  >
                    {nonGolden.map((b) => (
                      <option key={b} value={b}>{TIME_BLOCK_INFO[b].icon} {TIME_BLOCK_INFO[b].label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          ))}
        </div>
        <button
          onClick={() => setEntries((e) => [...e, { title: '', estimatedMinutes: 60, timeBlock: 'morning' }])}
          className="w-full py-2 border border-dashed border-gray-300 rounded-xl text-sm text-gray-500 mb-4"
        >
          ＋ もう1件追加
        </button>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-gray-200 text-sm text-gray-600">キャンセル</button>
          <button onClick={submit} className="flex-1 py-3 rounded-xl bg-indigo-600 text-white text-sm font-medium">追加</button>
        </div>
      </div>
    </div>
  );
}

// ── Home page ─────────────────────────────────────────────────────────────────
export default function Home({ store }: Props) {
  const {
    state, navigate,
    user, signIn,
    toggleTask, isTaskCompletedToday, getTodayTasks,
    getCurrentWeekMilestones, getMilestoneProgress,
    reorderTasksInBlock, addMeetings,
  } = store;

  // Real-time clock — updates every minute
  const [currentMin, setCurrentMin] = useState(nowMinutes);

  useEffect(() => {
    const tick = () => setCurrentMin(nowMinutes());
    tick(); // immediate sync
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  const [showMeetingModal, setShowMeetingModal] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const todayTasks = getTodayTasks();
  const currentWeekMs = getCurrentWeekMilestones();
  const week = getISOWeek();

  const totalEstimated = todayTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
  const endMin = timeToMinutes(state.endTimeToday);
  const remainingMin = Math.max(0, endMin - currentMin);
  const fixedTotal = state.fixedBlocks.reduce((s, f) => s + f.minutes, 0);
  const availableMin = Math.max(0, remainingMin - fixedTotal);
  const overBudget = totalEstimated > availableMin;
  const progressPct = availableMin > 0 ? Math.min((totalEstimated / availableMin) * 100, 100) : 0;

  function getBlockTasks(block: TimeBlock): Task[] {
    return todayTasks.filter((t) => t.timeBlock === block);
  }

  const handleDragEnd = useCallback(
    (event: DragEndEvent, block: TimeBlock) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const blockTasks = getBlockTasks(block);
      const oldIndex = blockTasks.findIndex((t) => t.id === active.id);
      const newIndex = blockTasks.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = arrayMove(blockTasks, oldIndex, newIndex);
      reorderTasksInBlock(block, reordered.map((t) => t.id));
    },
    [todayTasks],
  );

  const unassigned = todayTasks.filter((t) => !t.timeBlock);

  // Milestone cards
  const msByArea = state.goals
    .map((goal) => {
      const milestones = currentWeekMs.filter((m) => m.goalId === goal.id);
      if (!milestones.length) return null;
      return { goal, milestones };
    })
    .filter(Boolean) as { goal: (typeof state.goals)[0]; milestones: typeof currentWeekMs }[];

  return (
    <div className="px-4 py-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-medium text-gray-500">{todayLabel()}</p>
        <div className="flex gap-2">
          <button
            onClick={() => setShowMeetingModal(true)}
            className="text-xs bg-sky-500 text-white px-3 py-1.5 rounded-full font-medium"
          >
            📅 ミーティング
          </button>
          <button
            onClick={() => navigate('tasks')}
            className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-full font-medium"
          >
            ＋ タスク
          </button>
        </div>
      </div>

      {/* ── Cloud sync nudge (shown only when not logged in) ──────────── */}
      {!user && (
        <button
          onClick={signIn}
          className="w-full mb-3 bg-indigo-50 border border-indigo-100 rounded-2xl px-4 py-2.5 flex items-center gap-3 text-left"
        >
          <span className="text-xl">☁️</span>
          <div className="flex-1">
            <p className="text-xs font-semibold text-indigo-700">クラウド同期でマルチデバイス対応</p>
            <p className="text-[11px] text-indigo-500">Googleログインでどのデバイスからでも同じデータに</p>
          </div>
          <span className="text-xs text-indigo-600 font-medium whitespace-nowrap">ログイン →</span>
        </button>
      )}

      {/* ── Today's timeline (real-time) ───────────────────────────────── */}
      <TimelineWidget
        store={store}
        currentMin={currentMin}
        onNavigateTasks={() => navigate('tasks')}
      />

      {/* ── Overall progress bar ───────────────────────────────────────── */}
      <section className="bg-white rounded-2xl shadow-sm p-4 mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-500 font-medium">タスク合計</span>
          <span className={`text-xs font-bold ${overBudget ? 'text-red-500' : 'text-gray-700'}`}>
            {formatMinutes(totalEstimated)} / {formatMinutes(availableMin)}
            {overBudget && ' ⚠️'}
          </span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${overBudget ? 'bg-red-400' : 'bg-indigo-400'}`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </section>

      {/* ── This week's milestones ─────────────────────────────────────── */}
      {msByArea.length > 0 && (
        <section className="mb-4">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            今週のマイルストーン（{formatWeek(week)}）
          </h2>
          <div className="flex flex-col gap-2">
            {msByArea.map(({ goal, milestones }) => {
              const aStyle = AREA_STYLE[goal.area];
              return milestones.map((ms) => {
                const { done, total } = getMilestoneProgress(ms.id);
                const pct = total > 0 ? (done / total) * 100 : 0;
                return (
                  <div key={ms.id} className={`bg-white rounded-xl shadow-sm p-3 border-l-4 ${aStyle.border}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full text-white ${aStyle.badge}`}>
                        {goal.area}
                      </span>
                      <span className="text-[10px] text-gray-400">{done}/{total}</span>
                    </div>
                    <p className="text-sm font-medium text-gray-800">{ms.title}</p>
                    <div className="mt-1.5 w-full bg-gray-100 rounded-full h-1.5">
                      <div className={`h-1.5 rounded-full ${aStyle.bar}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              });
            })}
          </div>
        </section>
      )}

      {/* ── Time blocks ───────────────────────────────────────────────── */}
      <section>
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">タイムブロック</h2>
        <div className="flex flex-col gap-3">
          {TIME_BLOCKS.map((block) => {
            const info = TIME_BLOCK_INFO[block];
            const blockTasks = getBlockTasks(block);
            const blockTotal = blockTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);

            return (
              <div key={block} className={`rounded-2xl border ${info.border} ${info.bg} overflow-hidden`}>
                <div className="px-3 py-2.5 flex items-center justify-between">
                  <div>
                    <span className={`text-sm font-bold ${info.color}`}>
                      {info.icon} {info.label}
                    </span>
                    <p className="text-[10px] text-gray-500 mt-0.5">{info.hint}</p>
                  </div>
                  {blockTotal > 0 && (
                    <span className={`text-xs font-medium ${info.color}`}>{formatMinutes(blockTotal)}</span>
                  )}
                </div>
                {blockTasks.length > 0 ? (
                  <div className="px-3 pb-3">
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={(e) => handleDragEnd(e, block)}
                    >
                      <SortableContext
                        items={blockTasks.map((t) => t.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        <div className="flex flex-col gap-1.5">
                          {blockTasks.map((task) => (
                            <SortableTaskRow
                              key={task.id}
                              task={task}
                              isCompletedToday={isTaskCompletedToday(task)}
                              onToggle={() => toggleTask(task.id)}
                            />
                          ))}
                        </div>
                      </SortableContext>
                    </DndContext>
                  </div>
                ) : (
                  <div className="px-3 pb-3">
                    <p className="text-xs text-gray-400 text-center py-1.5">タスクなし</p>
                  </div>
                )}
              </div>
            );
          })}

          {/* Unassigned */}
          {unassigned.length > 0 && (
            <div className="rounded-2xl border border-gray-200 bg-gray-50 overflow-hidden">
              <div className="px-3 py-2.5">
                <span className="text-sm font-bold text-gray-500">📋 未割り当て</span>
              </div>
              <div className="px-3 pb-3 flex flex-col gap-1.5">
                {unassigned.map((task) => (
                  <div
                    key={task.id}
                    className={`bg-white rounded-xl shadow-sm px-3 py-2.5 flex items-center gap-2 ${
                      task.area ? `border-l-4 ${AREA_STYLE[task.area].border}` : 'border-l-4 border-gray-200'
                    }`}
                  >
                    <button
                      onClick={() => toggleTask(task.id)}
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                        isTaskCompletedToday(task) ? 'bg-indigo-500 border-indigo-500' : 'border-gray-300'
                      }`}
                    >
                      {isTaskCompletedToday(task) && (
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium truncate ${isTaskCompletedToday(task) ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                        {task.title}
                      </p>
                      <p className="text-xs text-gray-400">{formatMinutes(task.estimatedMinutes)}</p>
                    </div>
                    {task.isCarryOver && (
                      <span className="text-[10px] bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded">繰り越し</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {todayTasks.length === 0 && (
            <div className="text-center py-8 text-gray-400 text-sm">
              今日のタスクはありません
              <br />
              <button onClick={() => navigate('tasks')} className="mt-2 text-indigo-500 text-xs underline">
                タスクを追加する
              </button>
            </div>
          )}
        </div>
      </section>

      {showMeetingModal && (
        <MeetingModal onClose={() => setShowMeetingModal(false)} onAdd={addMeetings} />
      )}
    </div>
  );
}
