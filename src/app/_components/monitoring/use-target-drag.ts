'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { flushSync } from 'react-dom'
import { animate, useMotionValue, useReducedMotion, type MotionValue } from 'framer-motion'
import {
  UNGROUPED,
  locateTarget,
  moveTarget,
  withGroup,
  withoutEmptyGroup,
  type SidebarLayout,
  type TargetSlot,
} from '@/lib/sidebar-layout'

/**
 * Pointer-driven dragging of sidebar targets, within and between groups.
 *
 * The row being dragged is drawn as a floating copy that follows the pointer
 * exactly, while the list underneath holds an empty slot where it would land.
 * Moving the slot is an ordinary state change, so the rows around it glide out
 * of the way through their own layout animations and a row can cross into
 * another group without anything clipping or constraining it. On release the
 * copy springs into the slot and the real row takes its place.
 *
 * Nothing is saved until the drop: the arrangement is edited locally many
 * times during a drag and reported once at the end.
 */

/** How far the pointer must travel before a press on the handle becomes a drag. */
const DRAG_THRESHOLD_PX = 4
/** Distance from the list's top or bottom edge at which it starts to scroll. */
const SCROLL_EDGE_PX = 48
const MAX_SCROLL_PX_PER_FRAME = 14

export const DRAG_SPRING = { type: 'spring', stiffness: 650, damping: 44, mass: 0.9 } as const

/**
 * The drop uses the same spring but stops sooner. Left to come fully to rest,
 * the copy sits motionless over its slot for a perceptible beat before the
 * real row takes over, and the list ignores the pointer for all of it.
 */
const SETTLE_SPRING = { ...DRAG_SPRING, restDelta: 0.5, restSpeed: 20 } as const

export interface ActiveTargetDrag {
  id: string
  /** The group the target was picked up from. */
  originGroup: string
  /** The group currently holding the empty slot. */
  overGroup: string
  width: number
  height: number
  /**
   * `dragging` while held; `settling` while the copy springs into its slot;
   * `absorbing` when it was dropped on a collapsed group and has no slot to
   * land in, so it shrinks into the group's header instead.
   */
  phase: 'dragging' | 'settling' | 'absorbing'
}

interface Gesture {
  id: string
  pointerId: number
  startX: number
  startY: number
  /** Where inside the row the pointer took hold, so the copy does not jump. */
  grabX: number
  grabY: number
  width: number
  height: number
  pointerX: number
  pointerY: number
  started: boolean
  /** The arrangement before the drag, restored on cancel or a no-op drop. */
  startLayout: SidebarLayout
  originGroup: string
  frame: number
}

interface UseTargetDragOptions {
  layout: SidebarLayout
  setLayout: (layout: SidebarLayout) => void
  /** Element containing every group; coordinates are measured relative to it. */
  rootRef: RefObject<HTMLElement | null>
  collapsedGroups: Set<string>
  /** Called once per drag that actually moved something. */
  onDrop: (layout: SidebarLayout, id: string, fromGroup: string) => void
}

interface UseTargetDragResult {
  active: ActiveTargetDrag | null
  /** Viewport position of the floating copy's top-left corner. */
  x: MotionValue<number>
  y: MotionValue<number>
  onHandlePointerDown: (id: string, event: ReactPointerEvent<HTMLElement>) => void
}

/**
 * Position from layout alone, ignoring transforms.
 *
 * Rows are mid-animation for most of a drag, and `getBoundingClientRect` would
 * report where a row is *drawn* rather than where it *is*. Deciding the drop
 * slot from drawn positions makes a row that is still sliding away look as if
 * it were back under the pointer, and the slot flickers between two places.
 */
function layoutOffset(element: HTMLElement): { top: number; left: number } {
  let top = 0
  let left = 0
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) {
    top += node.offsetTop
    left += node.offsetLeft
  }
  return { top, left }
}

export function useTargetDrag({
  layout,
  setLayout,
  rootRef,
  collapsedGroups,
  onDrop,
}: UseTargetDragOptions): UseTargetDragResult {
  const [active, setActive] = useState<ActiveTargetDrag | null>(null)
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const reducedMotion = useReducedMotion()

  const gestureRef = useRef<Gesture | null>(null)
  const listenersRef = useRef<(() => void) | null>(null)

  // The gesture handlers run outside React's render cycle and must see the
  // current values, not the ones captured when the drag began.
  const layoutRef = useRef(layout)
  const collapsedRef = useRef(collapsedGroups)
  const onDropRef = useRef(onDrop)
  const setLayoutRef = useRef(setLayout)
  useEffect(() => {
    layoutRef.current = layout
    collapsedRef.current = collapsedGroups
    onDropRef.current = onDrop
    setLayoutRef.current = setLayout
  }, [layout, collapsedGroups, onDrop, setLayout])

  const commit = useCallback((next: SidebarLayout) => {
    if (next === layoutRef.current) return
    layoutRef.current = next
    setLayoutRef.current(next)
  }, [])

  /** The slot the floating copy is currently over, from its vertical centre. */
  const slotUnderCopy = useCallback((gesture: Gesture): TargetSlot | null => {
    const root = rootRef.current
    if (!root) return null

    const rootTop = layoutOffset(root).top
    const centreY = gesture.pointerY - gesture.grabY + gesture.height / 2 - root.getBoundingClientRect().top

    let nearest: HTMLElement | null = null
    let nearestDistance = Infinity
    for (const group of root.querySelectorAll<HTMLElement>('[data-group]')) {
      const top = layoutOffset(group).top - rootTop
      const bottom = top + group.offsetHeight
      const distance = centreY < top ? top - centreY : centreY > bottom ? centreY - bottom : 0
      if (distance < nearestDistance) {
        nearest = group
        nearestDistance = distance
      }
    }

    const groupName = nearest?.dataset.group
    if (!nearest || groupName === undefined) return null

    // A collapsed group shows no rows to slot between, so a drop on it goes to
    // the end.
    if (collapsedRef.current.has(groupName)) {
      return { group: groupName, index: Number.MAX_SAFE_INTEGER }
    }

    // The slot index is the number of other rows whose middle is above the
    // copy's middle: a row gives way once the copy overlaps it by half.
    let index = 0
    for (const row of nearest.querySelectorAll<HTMLElement>('[data-target-id]')) {
      if (row.dataset.targetId === gesture.id) continue
      const middle = layoutOffset(row).top - rootTop + row.offsetHeight / 2
      if (middle < centreY) index++
    }
    return { group: groupName, index }
  }, [rootRef])

  const scrollNearEdges = useCallback((gesture: Gesture) => {
    const viewport = rootRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) return

    const rect = viewport.getBoundingClientRect()
    const speed = (distance: number) =>
      Math.ceil(MAX_SCROLL_PX_PER_FRAME * (1 - Math.max(0, distance) / SCROLL_EDGE_PX))

    const fromTop = gesture.pointerY - rect.top
    const fromBottom = rect.bottom - gesture.pointerY
    if (fromTop < SCROLL_EDGE_PX) viewport.scrollTop -= speed(fromTop)
    else if (fromBottom < SCROLL_EDGE_PX) viewport.scrollTop += speed(fromBottom)
  }, [rootRef])

  const updateSlot = useCallback((gesture: Gesture) => {
    const slot = slotUnderCopy(gesture)
    if (!slot) return

    commit(moveTarget(layoutRef.current, gesture.id, slot))
    setActive(current =>
      current && current.overGroup !== slot.group ? { ...current, overGroup: slot.group } : current
    )
  }, [slotUnderCopy, commit])

  const releaseGesture = useCallback(() => {
    const gesture = gestureRef.current
    if (gesture) cancelAnimationFrame(gesture.frame)
    listenersRef.current?.()
    listenersRef.current = null
    gestureRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const finish = useCallback(async (cancelled: boolean) => {
    const gesture = gestureRef.current
    if (!gesture) return

    cancelAnimationFrame(gesture.frame)
    listenersRef.current?.()
    listenersRef.current = null

    if (!gesture.started) {
      releaseGesture()
      return
    }

    // Take the final reading here rather than trusting the last frame, and
    // commit it synchronously: the slot has to be in the DOM before its
    // position can be measured for the copy to land on.
    const slot = cancelled ? null : slotUnderCopy(gesture)
    const moved = slot ? moveTarget(layoutRef.current, gesture.id, slot) : gesture.startLayout
    const from = locateTarget(gesture.startLayout, gesture.id)
    const to = locateTarget(moved, gesture.id)
    const changed = !!from && !!to && (from.group !== to.group || from.index !== to.index)
    // Putting back the original object, rather than an equal copy, is what
    // removes the temporary Ungrouped drop zone after a drag that went nowhere.
    const final = changed ? withoutEmptyGroup(moved, UNGROUPED) : gesture.startLayout

    flushSync(() => commit(final))

    const root = rootRef.current
    const landing = to?.group ?? gesture.originGroup
    const slotElement = root?.querySelector<HTMLElement>(`[data-target-id="${CSS.escape(gesture.id)}"]`)
    const restingElement =
      slotElement ?? root?.querySelector<HTMLElement>(`[data-group="${CSS.escape(landing)}"]`)

    setActive(current =>
      current ? { ...current, overGroup: landing, phase: slotElement ? 'settling' : 'absorbing' } : current
    )

    if (changed) onDropRef.current(final, gesture.id, gesture.originGroup)

    if (root && restingElement) {
      const rootRect = root.getBoundingClientRect()
      const rootOffset = layoutOffset(root)
      const rest = layoutOffset(restingElement)
      const restX = rootRect.left + rest.left - rootOffset.left
      const restY = rootRect.top + rest.top - rootOffset.top

      if (reducedMotion) {
        x.jump(restX)
        y.jump(restY)
      } else {
        await Promise.all([animate(x, restX, SETTLE_SPRING), animate(y, restY, SETTLE_SPRING)])
      }
    }

    releaseGesture()
    setActive(null)
  }, [slotUnderCopy, commit, releaseGesture, rootRef, reducedMotion, x, y])

  const onHandlePointerDown = useCallback((id: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || gestureRef.current) return

    const row = event.currentTarget.closest<HTMLElement>('[data-target-id]')
    const origin = locateTarget(layoutRef.current, id)
    if (!row || !origin) return

    const rect = row.getBoundingClientRect()
    const gesture: Gesture = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      pointerX: event.clientX,
      pointerY: event.clientY,
      started: false,
      startLayout: layoutRef.current,
      originGroup: origin.group,
      frame: 0,
    }
    gestureRef.current = gesture

    const tick = () => {
      if (gestureRef.current !== gesture) return
      scrollNearEdges(gesture)
      updateSlot(gesture)
      gesture.frame = requestAnimationFrame(tick)
    }

    const begin = () => {
      gesture.started = true
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'

      // There is nowhere to drop a target to take it out of its group unless
      // an Ungrouped group happens to exist, so offer one for the duration.
      commit(withGroup(layoutRef.current, UNGROUPED))
      setActive({
        id,
        originGroup: gesture.originGroup,
        overGroup: gesture.originGroup,
        width: gesture.width,
        height: gesture.height,
        phase: 'dragging',
      })
      gesture.frame = requestAnimationFrame(tick)
    }

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== gesture.pointerId) return
      gesture.pointerX = moveEvent.clientX
      gesture.pointerY = moveEvent.clientY

      if (!gesture.started) {
        const travelled = Math.hypot(gesture.pointerX - gesture.startX, gesture.pointerY - gesture.startY)
        if (travelled < DRAG_THRESHOLD_PX) return
        begin()
      }

      // Set directly rather than through React: the copy has to track the
      // pointer on every event, not on the next render.
      x.set(gesture.pointerX - gesture.grabX)
      y.set(gesture.pointerY - gesture.grabY)
    }

    const handleUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === gesture.pointerId) void finish(false)
    }
    const handleCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === gesture.pointerId) void finish(true)
    }
    const handleKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') void finish(true)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleCancel)
    window.addEventListener('keydown', handleKey)
    listenersRef.current = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleCancel)
      window.removeEventListener('keydown', handleKey)
    }
  }, [commit, finish, scrollNearEdges, updateSlot, x, y])

  // A sidebar that unmounts mid-drag must not leave listeners or a grabbing
  // cursor behind.
  useEffect(() => releaseGesture, [releaseGesture])

  return { active, x, y, onHandlePointerDown }
}
