// Linux x86_64 classic BPF, supplied on a dedicated FD to bubblewrap.
// This is defense in depth around namespaces/read-only mounts/rlimits, not a
// replacement for them. Unsupported architectures fail before launch.
export function codeActSeccompFilter(): Buffer {
  const instructions: Array<[number, number, number, number]> = [];
  const emit = (code: number, jt: number, jf: number, k: number) => { instructions.push([code, jt, jf, k]); };
  const load = (offset: number) => emit(0x20, 0, 0, offset);
  const equal = (value: number, jt: number, jf: number) => emit(0x15, jt, jf, value);
  const ret = (value: number) => emit(0x06, 0, 0, value);
  const deny = (nr: number, errno = 1) => { equal(nr, 0, 1); ret(0x00050000 | errno); };
  load(4); // seccomp_data.arch
  equal(0xc000003e, 1, 0); // AUDIT_ARCH_X86_64
  ret(0); // SECCOMP_RET_KILL (works on the target's older kernel)
  load(0); // seccomp_data.nr
  emit(0x35, 0, 1, 0x40000000); // Reject x32 ABI, including its alternate syscall numbering.
  ret(0);
  for (const nr of [
    29, 30, 31, 64, 65, 66, 67, 68, 69, 70, 71, // SysV IPC allocations
    41, 53, 57, 58, 101, 109, 112, // sockets, fork/vfork, ptrace, process-group escape
    134, 135, 154, 155, 165, 166, 167, 168, 169, 170, 171, 172, 173, 175, 176, 179,
    246, 248, 249, 250, 272, 298, 303, 304, 308, 310, 311, 312, 313, 319, 321, 322, 323,
    425, 428, 429, 430, 431, 432, 438, 442,
  ]) deny(nr);
  deny(435, 38); // clone3: ENOSYS makes libc fall back to the inspected clone syscall.
  equal(56, 0, 4); // clone: permit threads sharing this process's address-space budget only.
  load(16); // low 32 bits of clone flags
  emit(0x45, 1, 0, 0x00010000); // CLONE_THREAD
  ret(0x00050001);
  ret(0x7fff0000);
  ret(0x7fff0000);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], i) => {
    bytes.writeUInt16LE(code, i * 8);
    bytes.writeUInt8(jt, i * 8 + 2);
    bytes.writeUInt8(jf, i * 8 + 3);
    bytes.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return bytes;
}
