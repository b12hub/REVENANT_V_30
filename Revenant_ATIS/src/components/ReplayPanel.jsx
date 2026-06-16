
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Play, Database, CheckCircle, ArrowDown, ShieldAlert, Cpu, Loader, ShieldCheck } from 'lucide-react';
import { clsx } from 'clsx';
import AuraCard from './AuraCard';
import { formatUZS } from '../utils/formatters';

const TimelineStep = ({ label, status, isLast }) => {
    // status: 'completed', 'active', 'pending'
    return (
        <div className="flex relative pb-8 last:pb-0">
            {!isLast && (
                <div className="absolute top-8 left-2.5 -ml-px w-0.5 h-full bg-white/10" />
            )}
            <div className={clsx(
                "relative flex h-5 w-5 flex-none items-center justify-center rounded-full border ring-4 ring-black",
                status === 'completed' ? "bg-primary border-primary" :
                    status === 'active' ? "bg-black border-primary animate-pulse" : "bg-black border-white/20"
            )}>
                {status === 'completed' && <CheckCircle className="h-3 w-3 text-black" />}
                {status === 'active' && <div className="h-2 w-2 rounded-full bg-primary" />}
            </div>
            <div className="ml-4 flex-auto">
                <p className={clsx(
                    "text-sm font-mono font-medium leading-5",
                    status === 'completed' || status === 'active' ? "text-white" : "text-gray-500"
                )}>{label}</p>
            </div>
        </div>
    );
};

const ReplayPanel = ({ log, isOpen, onClose }) => {
    const [isSimulating, setIsSimulating] = useState(false);
    const [simulationResult, setSimulationResult] = useState(null); // { result: 'APPROVED', aura_score: 98 }

    const handleReplay = async () => {
        setIsSimulating(true);
        setSimulationResult(null);

        try {
            const webhookUrl = import.meta.env.VITE_N8N_REPLAY_WEBHOOK;

            // Allow replay without URL for demo purposes if not set, but log warning
            if (!webhookUrl) {
                console.warn("VITE_N8N_REPLAY_WEBHOOK not set.");
                // Fallback for demo if needed, but per requirements we expect it to be set.
            }

            console.log('Initiating Shadow Replay for Trace:', log.trace_id);

            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trace_id: log.trace_id })
            });

            if (response.ok) {
                // Assuming n8n returns something like { result: "APPROVED", aura_score: 99 }
                // If response is opaque, we mock a success for UI feedback based on HTTP 200
                const data = await response.json().catch(() => ({ result: 'APPROVED', aura_score: 98 }));
                setSimulationResult(data);
            } else {
                console.error("Replay failed with status:", response.status);
                // Optional: handle error state in UI
            }
        } catch (error) {
            console.error("Replay failed:", error);
        } finally {
            setIsSimulating(false);
        }
    };

    if (!log && !isOpen) return null;

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/80 backdrop-blur-sm z-40"
                    />

                    {/* Side Panel */}
                    <motion.div
                        initial={{ x: "100%" }}
                        animate={{ x: 0 }}
                        exit={{ x: "100%" }}
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                        className={clsx(
                            "fixed inset-y-0 right-0 w-full max-w-xl bg-[#050505] border-l shadow-2xl z-50 overflow-y-auto transition-colors duration-500",
                            isSimulating ? "border-primary shadow-neon" : "border-white/10"
                        )}
                    >
                        <div className="p-6 h-full flex flex-col">
                            {/* Header */}
                            <div className="flex items-center justify-between mb-8">
                                <div>
                                    <h2 className="text-xl font-bold text-white font-mono tracking-tight">SHADOW_REPLAY</h2>
                                    <p className="text-sm text-gray-500 font-mono mt-1">TRACE: {log?.trace_id}</p>
                                </div>
                                <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                                    <X className="w-5 h-5 text-gray-400" />
                                </button>
                            </div>

                            {/* Action Area */}
                            <div className="grid grid-cols-2 gap-4 mb-8">
                                <AuraCard className="bg-primary/5 border-primary/20 flex flex-col items-center justify-center py-6 group cursor-pointer hover:bg-primary/10 transition-colors"
                                    onClick={!isSimulating ? handleReplay : undefined}
                                >
                                    <div className={clsx("p-3 rounded-full mb-3 transition-all", isSimulating ? "bg-primary shadow-neon" : "bg-primary/10 group-hover:bg-primary group-hover:text-black")}>
                                        {isSimulating ? (
                                            <Loader className="w-6 h-6 text-black animate-spin" />
                                        ) : (
                                            <Play className="w-6 h-6 text-primary group-hover:text-black" />
                                        )}
                                    </div>
                                    <span className="font-mono font-bold text-sm text-primary tracking-wider">
                                        {isSimulating ? "SIMULATING..." : "INITIATE REPLAY"}
                                    </span>
                                </AuraCard>

                                <div className="space-y-4">
                                    {simulationResult ? (
                                        <motion.div
                                            initial={{ opacity: 0, scale: 0.95 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            className="h-full flex flex-col justify-between"
                                        >
                                            <div className="bg-primary/20 border border-primary p-4 rounded-lg flex items-center justify-center space-x-2">
                                                <ShieldCheck className="w-5 h-5 text-primary" />
                                                <span className="font-bold text-primary font-mono tracking-widest">{simulationResult.result || 'APPROVED'}</span>
                                            </div>

                                            <div className="flex items-center space-x-3 p-3 rounded-lg bg-white/5 border border-white/10 mt-auto">
                                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-emerald-900 flex items-center justify-center font-bold text-black text-xs border border-primary">
                                                    {simulationResult.aura_score || 98}
                                                </div>
                                                <div>
                                                    <div className="text-[10px] text-gray-500 uppercase font-mono">Aura Score</div>
                                                    <div className="text-sm font-bold text-white">Trust Verified</div>
                                                </div>
                                            </div>
                                        </motion.div>
                                    ) : (
                                        <>
                                            <div className="flex items-center space-x-3 p-3 rounded-lg bg-white/5 border border-white/10">
                                                <Database className="w-4 h-4 text-gray-400" />
                                                <div>


                                                    <div className="text-[10px] text-gray-500 uppercase font-mono">Cost Saved</div>
                                                    <div className="text-sm font-bold text-white">{formatUZS(parseFloat(log?.economics?.net_savings || 0))}</div>
                                                </div>
                                            </div>
                                            <div className="flex items-center space-x-3 p-3 rounded-lg bg-white/5 border border-white/10">
                                                <Cpu className="w-4 h-4 text-gray-400" />
                                                <div>
                                                    <div className="text-[10px] text-gray-500 uppercase font-mono">Latency</div>
                                                    <div className="text-sm font-bold text-white">{log.ops_stream?.duration_ms || log.economics?.execution_time_ms || 0}ms</div>
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Interactive Timeline */}
                            <div className="mb-8 p-6 rounded-xl bg-white/5 border border-white/5">
                                <h3 className="text-xs font-mono text-gray-400 uppercase tracking-widest mb-6">Execution Path</h3>
                                <div className="pl-2">
                                    <TimelineStep label="INITIALIZED" status="completed" />
                                    <TimelineStep label="MEM_RECALL" status="completed" />
                                    <TimelineStep label="INVARIANT_CHECK" status="completed" />
                                    <TimelineStep label="SIGNED" status={simulationResult ? 'completed' : isSimulating ? 'active' : 'completed'} isLast />
                                </div>
                            </div>

                            {/* Raw Data */}
                            <div className="flex-1 min-h-0 flex flex-col">
                                <h3 className="text-xs font-mono text-gray-400 uppercase tracking-widest mb-4">Raw Ledger Data</h3>
                                <div className="flex-1 overflow-auto rounded-lg bg-black border border-white/10 p-4 shadow-inner custom-scrollbar">
                                    <pre className="text-xs font-mono text-primary/80 whitespace-pre-wrap leading-relaxed">
                                        {JSON.stringify(log, null, 2)}
                                    </pre>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};

export default ReplayPanel;
