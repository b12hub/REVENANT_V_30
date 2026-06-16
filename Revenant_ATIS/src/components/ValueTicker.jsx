
import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatUZS } from '../utils/formatters';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';

const Digit = ({ value }) => (
    <div className="relative h-12 w-8 overflow-hidden inline-block align-bottom">
        <AnimatePresence mode='popLayout'>
            <motion.span
                key={value}
                initial={{ y: "100%" }}
                animate={{ y: "0%" }}
                exit={{ y: "-100%" }}
                transition={{ duration: 0.5, ease: "easeOut" }}
                className="absolute inset-0 flex items-center justify-center font-mono font-bold text-4xl md:text-5xl text-white text-glow"
            >
                {value}
            </motion.span>
        </AnimatePresence>
    </div>
);

// Mock data for sparkline (last 24h)
const data = [
    { value: 4000 }, { value: 3000 }, { value: 2000 }, { value: 2780 },
    { value: 1890 }, { value: 2390 }, { value: 3490 }, { value: 4000 },
    { value: 4500 }, { value: 4200 }, { value: 5000 }, { value: 5500 },
    { value: 5300 }, { value: 5800 }, { value: 6000 }, { value: 6500 },
    { value: 6300 }, { value: 6800 }, { value: 7200 }, { value: 7500 },
    { value: 7800 }, { value: 8000 }, { value: 8200 }, { value: 8500 }
];

const ValueTicker = ({ value, label = "TOTAL UZS SAVED" }) => {
    // For simplicity with formatUZS, we might just animate the whole string or specific numbers.
    // However, rolling digit usually implies per-digit animation. 
    // Given formatUZS returns a string with " UZS", let's animate the number part specifically or just use a Spring counter.
    // The prompt asks for "Rolling Digit effect so numbers animate upwards".

    // A simpler high-impact approach for "rolling":
    // Split the formatted number (without UZS) into chars and animate them.

    const safeValue = value ?? 0;
    const formatted = formatUZS(safeValue).replace(' UZS', '');
    const chars = formatted.split('');

    return (
        <div className="flex flex-col relative">
            <span className="text-gray-400 font-mono text-sm uppercase tracking-widest mb-2 z-10">{label}</span>
            <div className="flex items-baseline space-x-1 z-10">
                <div className="flex overflow-hidden h-14 items-center">
                    {chars.map((char, index) => {
                        if (char === ',' || char === '.') {
                            return <span key={index} className="text-4xl md:text-5xl font-mono text-white/50">{char}</span>;
                        }
                        // Use key logic to trigger animation on change? 
                        // For a real "rolling" driven by prop change, we typically need to track previous value.
                        // But standard react key change triggers enter/exit.
                        return <Digit key={`${index}-${char}`} value={char} />
                    })}
                </div>
                <span className="text-xl text-primary font-bold ml-2">UZS</span>
            </div>

            {/* Sparkline Background */}
            <div className="absolute -bottom-6 -right-6 w-48 h-24 opacity-30 pointer-events-none">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data}>
                        <defs>
                            <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#00FF9D" stopOpacity={0.8} />
                                <stop offset="95%" stopColor="#00FF9D" stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <Area type="monotone" dataKey="value" stroke="#00FF9D" fillOpacity={1} fill="url(#colorValue)" strokeWidth={2} />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};

export default ValueTicker;
