'use client'

import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from './button'

interface Props {
  children: React.ReactNode
  /** Shown in the fallback so the user knows which part failed. */
  label: string
}

interface State {
  error: Error | null
}

/**
 * Contains a render failure to one region.
 *
 * The chart does arithmetic on data that arrives from the network, so a
 * malformed row should degrade that panel rather than blank the whole
 * dashboard — the stat cards and sidebar remain useful even when the graph
 * cannot draw.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[${this.props.label}] render failed:`, error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex min-h-[16rem] flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 p-6 text-center">
        <AlertTriangle className="h-6 w-6 text-destructive" />
        <div>
          <p className="text-sm font-medium text-foreground">{this.props.label} could not be displayed</p>
          <p className="mt-1 text-xs text-muted-foreground">{this.state.error.message}</p>
        </div>
        <Button variant="outline" size="sm" onClick={this.reset}>
          Try again
        </Button>
      </div>
    )
  }
}
