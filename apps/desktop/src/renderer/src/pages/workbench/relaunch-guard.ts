/** 续接 / 重新开始的重入闩。持有期间第二次进入直接拒绝。 */

export function createRelaunchGuard(): {
  tryEnter: () => boolean;
  leave: () => void;
} {
  let held = false;
  return {
    tryEnter(): boolean {
      if (held) {
        return false;
      }
      held = true;
      return true;
    },
    leave(): void {
      held = false;
    },
  };
}
