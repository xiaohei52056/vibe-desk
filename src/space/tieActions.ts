/**
 * 剪线 / 连线的统一动作层。
 *
 * 删除有三个入口（拖拽到已连的星、长按浮层的 ✕、项目线本体上的 ✕），
 * 它们都必须走这里，才能保证「删完可撤销」这一条不漏。
 * 撤销不是回滚快照，而是重新连一次 —— 关系表是唯一真相，重连即恢复。
 */
import { connectTie, disconnectTie, hasTie } from '../notes/ties';
import { toast, toastAction } from '../ui/toast';

function offerUndo(a: string, b: string, la: string, lb: string): void {
  toastAction(`已断开 ${la} ↔ ${lb}`, '撤销', () => {
    void connectTie(a, b).then(ok => {
      toast(ok ? '已恢复连线' : '恢复失败 · 这颗星已经不在了');
    });
  });
}

/** 长按拖拽到目标：没连过就连接，连过就剪断 */
export async function toggleTie(a: string, b: string, la: string, lb: string): Promise<boolean> {
  const existed = hasTie(a, b);
  const ok = existed ? await disconnectTie(a, b) : await connectTie(a, b);
  if (!ok) return false;
  if (existed) offerUndo(a, b, la, lb);
  else toast(`已连接 ${la} ↔ ${lb}`);
  return true;
}

/** 只剪断，不新建；给浮层和线本体上的 ✕ 用 */
export async function cutTie(a: string, b: string, la: string, lb: string): Promise<boolean> {
  const ok = await disconnectTie(a, b);
  if (!ok) return false;
  offerUndo(a, b, la, lb);
  return true;
}
