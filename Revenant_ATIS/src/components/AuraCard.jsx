
import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { motion } from 'framer-motion';

const AuraCard = ({ children, className, noHover = false }) => {
    return (
        <motion.div
            className={twMerge(
                "glass-panel rounded-xl p-6 border border-white/10 relative overflow-hidden",
                className
            )}
            whileHover={!noHover ? { scale: 1.02, borderColor: "rgba(0, 255, 157, 0.3)" } : {}}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
        >
            {/* Ambient background glow for depth */}
            <div className="absolute -top-10 -right-10 w-32 h-32 bg-primary/5 rounded-full blur-3xl pointer-events-none" />

            <div className="relative z-10">
                {children}
            </div>
        </motion.div>
    );
};

export default AuraCard;
