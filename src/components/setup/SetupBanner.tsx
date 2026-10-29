"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { getStatus } from "./api";

// Home: a calm card above the composer, only while lambda isn't set up yet.
export function SetupBanner() {
  const still = useReducedMotion() ?? false;
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    getStatus().then(
      (s) => live && setShow(!s.configured),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          transition={still ? { duration: 0.15 } : { type: "spring", stiffness: 260, damping: 32 }}
          className="relative z-10 overflow-hidden"
        >
          <div className="card mb-5 flex items-center gap-4 overflow-hidden py-0 pl-5 pr-4 sm:pr-5">
            <Image src="/art/muse-orb.webp" alt="" aria-hidden width={900} height={1393} className="fade-b -mb-4 mt-2 hidden w-[52px] shrink-0 sm:block" />
            <div className="min-w-0 py-4">
              <p className="display whitespace-nowrap text-[20px] leading-tight">set up lambda</p>
              <p className="mt-0.5 hidden text-[12px] text-grey sm:block">mostly automatic · two minutes</p>
            </div>
            <Link href="/setup" className="btn btn-primary ml-auto shrink-0">
              start setup <span aria-hidden>→</span>
            </Link>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
