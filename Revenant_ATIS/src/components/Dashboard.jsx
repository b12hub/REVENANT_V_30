import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Lock, Search, PlayCircle, Grid, Settings, Bell, LogOut, User, ShieldAlert } from 'lucide-react';
import AuraCard from './AuraCard';
import ValueTicker from './ValueTicker';
import ReplayPanel from './ReplayPanel';
import SecurityPulse from './SecurityPulse';
import SystemStatus from './SystemStatus';
import WorkflowsView from './WorkflowsView';
import LiveAuditView from './LiveAuditView';
import TraceLogsView from './TraceLogsView';
import AdvisoryPanel from './AdvisoryPanel';
import { useExecutiveMetrics } from '../hooks/useExecutiveMetrics';
import { useRevenantListener } from '../hooks/useRevenantListener';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '../lib/supabaseClient';

const Dashboard = () => {
    const { metrics, loading } = useExecutiveMetrics();
    const [selectedLog, setSelectedLog] = useState(null);
    const [currentView, setCurrentView] = useState('overview');
    const [showUserMenu, setShowUserMenu] = useState(false);
    const [showNotifications, setShowNotifications] = useState(false);
    const [latestLog, setLatestLog] = useState(null);

    // Advisory State
    const [advisoryData, setAdvisoryData] = useState(null);
    const [isAdvisoryOpen, setIsAdvisoryOpen] = useState(false);

    // Handle incoming advisory
    const handleAdvisory = useCallback((data) => {
        setAdvisoryData(data);
        setIsAdvisoryOpen(true);
        // Optional: Play sound or show toast here
        console.log("Advisory Received:", data);
    }, []);

    // Activate the listener
    useRevenantListener(handleAdvisory);

    // Mock Trigger for Development/Verification
    const triggerMockAdvisory = () => {
        handleAdvisory({
            internal_reference: `SIM-${Date.now()}`,
            advisory_hash: 'abc-123-hash-simulated',
            idempotence_key: 'idempotency-key-uuid-v4',
            advisory_package: {
                draft_response: "The transaction exceeds velocity limits for this user segment based on the last 24h rolling window. High probability of structured layering.",
                suggested_actions: ["Freeze Account Temporary", "Call Customer via Secure Line", "File SAR Report"]
            }
        });
    };

    // Expose mock trigger to window for console access if needed
    useEffect(() => {
        window.triggerAdvisory = triggerMockAdvisory;
    }, [handleAdvisory]);

    React.useEffect(() => {
        const fetchLatestLog = async () => {
            const { data } = await supabase
                .from('audit_ledger')
                .select('ops_stream, created_at')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            if (data) setLatestLog(data);
        };
        fetchLatestLog();
        // Optional: subscribe for real-time updates if strictly needed, but fetch on mount covers the request base requirements.
        // For "Forensic Alerts", a polling interval or subscription is better. Let's add a simple poll.
        const interval = setInterval(fetchLatestLog, 10000);
        return () => clearInterval(interval);
    }, []);

    const getTimeAgo = (dateString) => {
        if (!dateString) return 'Unknown';
        const now = new Date();
        const past = new Date(dateString);
        const diffMs = now - past;
        const diffMins = Math.floor(diffMs / 60000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        return `${Math.floor(diffHours / 24)}d ago`;
    };

    if (loading) return (
        <div className="bg-[#050505] h-screen flex flex-col items-center justify-center text-[#00FF9D] font-mono">
            <div className="w-12 h-12 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4" />
            <div className="animate-pulse tracking-widest">INITIALIZING_SECURE_STREAM...</div>
        </div>
    );

    // Dynamic Metrics mapping from SQL RPC
    const totalSavings = metrics ? metrics.total_savings : 0;

    // Risk Mitigation Calculation: (Rejected / Processed) * 100
    const processedTickets = metrics ? metrics.processed_tickets : 0;
    const rejectedTickets = metrics ? metrics.rejected_tickets : 0;
    const riskMitigation = processedTickets > 0
        ? ((rejectedTickets / processedTickets) * 100).toFixed(1)
        : 100; // Default to 100% if no tickets processed yet (safe state)

    const activeWorkflows = metrics ? metrics.active_workflows : 0;
    const isRiskCritical = riskMitigation < 95;

    const renderContent = () => {
        switch (currentView) {
            case 'live_audit':
                return <LiveAuditView onSelectLog={setSelectedLog} />;
            case 'trace_logs':
                return <TraceLogsView onSelectLog={setSelectedLog} />;
            case 'workflows':
                return <WorkflowsView />;
            case 'system':
                return <SystemStatus />;
            case 'overview':
            default:
                return (
                    <div className="p-6 lg:p-8 max-w-[1600px] mx-auto grid grid-cols-12 gap-4">
                        {/* Primary Metric: Total Savings */}
                        <div className="col-span-12 lg:col-span-8">
                            <AuraCard className="h-full flex flex-col justify-center min-h-[250px] bg-gradient-to-br from-black/60 to-black/40">
                                <div className="flex-1 flex flex-col justify-center">
                                    <ValueTicker value={totalSavings} />
                                    <p className="mt-4 text-base text-gray-400 max-w-md leading-relaxed">
                                        Automated PII neutralization has prevented <span className="text-white font-semibold">potential regulatory fines</span> equivalent to this amount.
                                    </p>
                                </div>
                                <div className="mt-6 flex items-center space-x-4">
                                    <div className="text-xs font-mono text-primary/60 border border-primary/20 px-2 py-1 rounded bg-primary/5 uppercase">
                                        Vault_Link: {loading ? 'SYNCING...' : 'ENFORCED'}
                                    </div>
                                    <div className="text-[10px] font-mono text-gray-500 uppercase">
                                        Last Sync: {new Date().toLocaleTimeString()}
                                    </div>
                                </div>
                            </AuraCard>
                        </div>

                        {/* Security Pulse Feed */}
                        <div className="col-span-12 lg:col-span-4 lg:row-span-2 min-h-[500px]">
                            <SecurityPulse onSelectLog={setSelectedLog} />
                        </div>

                        {/* Secondary Metric: Risk Mitigation (Dynamic) */}
                        <div className="col-span-12 lg:col-span-4">
                            <AuraCard className="bg-black/40">
                                <h3 className="text-gray-400 text-sm font-mono mb-2 uppercase">Risk Mitigation</h3>
                                <div className={`text-3xl font-bold tracking-tighter transition-colors duration-500 ${isRiskCritical ? 'text-red-500' : 'text-white'}`}>
                                    {riskMitigation}%
                                </div>
                                <div className="w-full bg-white/10 h-1 mt-4 rounded-full overflow-hidden">
                                    <div
                                        style={{ width: `${riskMitigation}%` }}
                                        className={`h-full shadow-neon transition-all duration-1000 ease-out ${isRiskCritical ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.6)]' : 'bg-primary'}`}
                                    />
                                </div>
                            </AuraCard>
                        </div>

                        {/* Secondary Metric: Active Workflows (Dynamic) */}
                        <div className="col-span-12 lg:col-span-4">
                            <AuraCard className="bg-black/40">
                                <h3 className="text-gray-400 text-sm font-mono mb-2 uppercase">Active Workflows</h3>
                                <div className="text-3xl font-bold text-white tracking-tighter">{activeWorkflows}</div>
                                <div className="flex space-x-1 mt-4">
                                    {/* Generate pips based on count - showing max 8 for UI balance */}
                                    {Array.from({ length: 8 }).map((_, i) => (
                                        <div
                                            key={i}
                                            className={`h-1 flex-1 rounded-full transition-all duration-700 ${i < activeWorkflows ? 'bg-primary/40 shadow-neon' : 'bg-white/10'
                                                }`}
                                        />
                                    ))}
                                </div>
                            </AuraCard>
                        </div>
                    </div>
                );
        }
    };

    return (
        <div className="min-h-screen bg-background text-white font-sans selection:bg-primary/30 selection:text-primary flex overflow-hidden">

            {/* Sidebar Navigation */}
            <aside className="w-20 lg:w-64 border-r border-white/10 flex flex-col items-center lg:items-stretch py-8 bg-black/40 backdrop-blur-xl z-20">
                <div className="lg:px-6 mb-12 flex items-center justify-center lg:justify-start">
                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-emerald-900 flex items-center justify-center shadow-neon">
                        <Lock className="w-5 h-5 text-black" />
                    </div>
                    <span className="hidden lg:block ml-3 font-bold text-lg tracking-wider">REVENANT</span>
                </div>

                <nav className="flex-1 space-y-2 px-4">
                    {[
                        { icon: Grid, label: 'Overview', id: 'overview' },
                        // { icon: Activity, label: 'Live Audit', id: 'live_audit' }, // Hidden as requested
                        { icon: Search, label: 'Trace Logs', id: 'trace_logs' },
                        // { icon: PlayCircle, label: 'Workflows', id: 'workflows' }, // Hidden as requested
                        { icon: Settings, label: 'System', id: 'system' }
                    ].map((item) => (
                        <button
                            key={item.id}
                            onClick={() => setCurrentView(item.id)}
                            className={`w-full flex items-center p-3 rounded-xl transition-all group ${currentView === item.id
                                ? 'bg-primary/10 text-primary border border-primary/20'
                                : 'text-gray-400 hover:text-white hover:bg-white/5'
                                }`}
                        >
                            <item.icon className="w-6 h-6 lg:w-5 lg:h-5" />
                            <span className="hidden lg:block ml-3 text-sm font-medium">{item.label}</span>
                            {currentView === item.id && (
                                <motion.div
                                    layoutId="nav-glow"
                                    className="ml-auto w-1.5 h-1.5 rounded-full bg-primary shadow-neon hidden lg:block"
                                />
                            )}
                        </button>
                    ))}
                </nav>
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 relative overflow-y-auto overflow-x-hidden">
                <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-b from-primary/5 to-transparent pointer-events-none" />

                {/* Header */}
                <header className="sticky top-0 z-10 px-6 py-4 flex items-center justify-between backdrop-blur-sm border-b border-white/5 bg-black/20 max-w-[1600px] mx-auto w-full">
                    <h1 className="text-xl font-bold tracking-tight text-white/90">Executive Cockpit</h1>

                    <div className="flex items-center space-x-6">
                        {/* Mock Trigger for Verification - Hidden in production or kept for demo */}
                        <button
                            onClick={triggerMockAdvisory}
                            className="p-2 text-xs font-mono text-emerald-500 border border-emerald-500/20 rounded bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors"
                            title="Simulate Advisory Signal"
                        >
                            SIM_SIGNAL
                        </button>

                        <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-black/40 border border-white/10 hidden md:flex">
                            <div className={`w-2 h-2 rounded-full ${isRiskCritical ? 'bg-red-500' : 'bg-primary'} animate-pulse shadow-neon`} />
                            <span className={`text-[10px] font-mono font-bold ${isRiskCritical ? 'text-red-500' : 'text-primary'} tracking-wider uppercase`}>
                                Status: {isRiskCritical ? 'DEGRADED' : 'Enforced'}
                            </span>
                        </div>

                        {/* Notifications */}
                        <div className="relative">
                            <Bell
                                className="w-5 h-5 text-gray-400 hover:text-white cursor-pointer transition-colors"
                                onClick={() => setShowNotifications(!showNotifications)}
                            />
                            <AnimatePresence>
                                {showNotifications && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                                        className="absolute right-0 mt-2 w-72 bg-black/90 border border-white/10 rounded-xl shadow-2xl p-4 backdrop-blur-md z-50"
                                    >
                                        <div className="font-mono text-[10px] text-primary border-b border-white/10 pb-2 mb-3 tracking-widest uppercase">Forensic Alerts</div>
                                        <div className="space-y-3">
                                            <div className={`text-sm font-medium leading-relaxed border-l-2 pl-3 ${latestLog?.ops_stream?.status === 'POLICIES_CLEAN' ? 'border-primary/50 text-white' : 'border-red-500/50 text-red-100'}`}>
                                                {latestLog ? (
                                                    latestLog?.ops_stream?.status === 'POLICIES_CLEAN'
                                                        ? "System Operational. No violations detected in latest cycle."
                                                        : `⚠️ Compliance Alert: ${latestLog?.ops_stream?.status || 'SYSTEM_INIT'} detected.`
                                                ) : "Initializing Monitor..."}
                                            </div>
                                            <div className="flex items-center justify-between text-xs text-gray-400 font-mono mt-2">
                                                <span>Audit Trail: {((metrics?.latest_latency || 0) / 60000).toFixed(1)} min</span>
                                                <span>Last Activity: {latestLog?.created_at ? getTimeAgo(latestLog.created_at) : 'Syncing...'}</span>
                                            </div>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* User Profile Menu */}
                        <div className="relative">
                            <div
                                className="w-8 h-8 rounded-full bg-gradient-to-tr from-gray-700 to-gray-600 border border-white/20 cursor-pointer hover:border-primary transition-all flex items-center justify-center overflow-hidden"
                                onClick={() => setShowUserMenu(!showUserMenu)}
                            >
                                <User className="w-4 h-4 text-white/50" />
                            </div>
                            <AnimatePresence>
                                {showUserMenu && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: 10 }}
                                        className="absolute right-0 mt-2 w-48 bg-black/90 border border-white/10 rounded-xl shadow-2xl overflow-hidden backdrop-blur-md z-50"
                                    >
                                        <div
                                            onClick={() => alert('REVENANT_V22: ACCESSING_SYSTEM_PARAMETERS...')}
                                            className="p-3 border-b border-white/10 hover:bg-white/5 cursor-pointer flex items-center space-x-2 text-sm text-gray-300 hover:text-white transition-colors"
                                        >
                                            <Settings className="w-4 h-4 text-primary/70" />
                                            <span>System Config</span>
                                        </div>
                                        <div
                                            onClick={() => window.location.reload()}
                                            className="p-3 hover:bg-white/5 cursor-pointer flex items-center space-x-2 text-sm text-red-400 hover:text-red-300 transition-colors"
                                        >
                                            <LogOut className="w-4 h-4" />
                                            <span>Terminate Session</span>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </div>
                </header>

                <AnimatePresence mode="wait">
                    <motion.div
                        key={currentView}
                        initial={{ opacity: 0, x: 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -10 }}
                        transition={{ duration: 0.2 }}
                    >
                        {renderContent()}
                    </motion.div>
                </AnimatePresence>

                <ReplayPanel
                    log={selectedLog}
                    isOpen={!!selectedLog}
                    onClose={() => setSelectedLog(null)}
                />

                {/* Advisory Panel - Real-time Interceptor */}
                <AdvisoryPanel
                    isOpen={isAdvisoryOpen}
                    onClose={() => setIsAdvisoryOpen(false)}
                    data={advisoryData}
                />
            </main>
        </div>
    );
};

export default Dashboard;