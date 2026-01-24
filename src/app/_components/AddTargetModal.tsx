'use client';

import React, { useState } from 'react';
import { ProbeType } from '@/types/probe';

interface AddTargetModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (target: {
    name: string;
    host: string;
    probeType: ProbeType;
    interval: number;
  }) => Promise<void>;
}

export function AddTargetModal({ isOpen, onClose, onAdd }: AddTargetModalProps) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [probeType, setProbeType] = useState<ProbeType>('ping');
  const [interval, setInterval] = useState(300); // Default to 5 minutes like SmokeICMP
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await onAdd({ name, host, probeType, interval });
      // Reset form
      setName('');
      setHost('');
      setProbeType('ping');
      setInterval(300);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add target');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Add Monitoring Target</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
              Target Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Google DNS"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="host" className="block text-sm font-medium text-gray-700 mb-1">
              Host / IP Address
            </label>
            <input
              id="host"
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="e.g., 8.8.8.8 or google.com"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="probeType" className="block text-sm font-medium text-gray-700 mb-1">
              Probe Type
            </label>
            <select
              id="probeType"
              value={probeType}
              onChange={(e) => setProbeType(e.target.value as ProbeType)}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="ping">ICMP</option>
              <option value="dns">DNS Query</option>
            </select>
          </div>

          <div>
            <label htmlFor="interval" className="block text-sm font-medium text-gray-700 mb-1">
              Probe Interval
            </label>
            <select
              id="interval"
              value={interval}
              onChange={(e) => setInterval(parseInt(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={30}>30 seconds (frequent)</option>
              <option value={60}>1 minute</option>
              <option value={120}>2 minutes</option>
              <option value={300}>5 minutes (default)</option>
              <option value={600}>10 minutes</option>
              <option value={1800}>30 minutes</option>
              <option value={3600}>1 hour</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              How often to automatically probe this target
            </p>
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded hover:bg-gray-50 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {loading ? 'Adding...' : 'Add Target'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
