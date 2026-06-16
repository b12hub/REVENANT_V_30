
import React from 'react';
import AuraCard from './AuraCard';
import { PlayCircle, GitBranch } from 'lucide-react';

const WorkflowsView = () => {
    return (
        <div className="p-6 lg:p-8 max-w-[1600px] mx-auto space-y-6">
            <h2 className="text-xl font-bold text-white font-mono tracking-tight mb-4">ACTIVE_WORKFLOWS</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[1, 2, 3, 4].map((i) => (
                    <AuraCard key={i} className="bg-black/60 flex items-center justify-between group cursor-pointer hover:bg-white/5 transition-colors">
                        <div className="flex items-center space-x-4">
                            <div className="p-3 bg-primary/10 rounded-full group-hover:bg-primary group-hover:text-black transition-colors">
                                <GitBranch className="w-5 h-5 text-primary group-hover:text-black" />
                            </div>
                            <div>
                                <div className="text-sm font-bold text-white">PII_NEUTRALIZATION_PROTOCOL_{i}0{i}</div>
                                <div className="text-xs text-gray-500 font-mono">Status: ACTIVE • Node: EMEA-WEST-{i}</div>
                            </div>
                        </div>
                        <PlayCircle className="w-5 h-5 text-gray-400 group-hover:text-primary" />
                    </AuraCard>
                ))}
            </div>
        </div>
    );
};

export default WorkflowsView;
