'use client'

import React from 'react'
import { Alert } from '@/components/arc/alert/alert'
import { Button } from '@/components/arc/button/button'

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
      <div className="space-y-3">
        <Alert tone="danger" title={`${this.props.label} could not be displayed`}>
          {this.state.error.message}
        </Alert>
        <Button variant="secondary" size="sm" onClick={this.reset}>
          Try again
        </Button>
      </div>
    )
  }
}
