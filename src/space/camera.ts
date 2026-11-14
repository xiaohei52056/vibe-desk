/**
 * 舞台状态层：只维护「开站 / 书写态」两个 class。
 *
 * 3D 是唯一的渲染路径。原先这里的 CSS 假景深、鼠标视差倾斜、
 * 2D 推近（--camZ）和拍平开关都已随 2D 星图一起移除 ——
 * 镜头交互现在全部由 Core3D 的真实透视相机负责。
 */
import { subscribe } from '../core/state';

export class Camera {
  constructor(stage: HTMLElement) {
    subscribe(s => {
      // .locked：详情页打开时暂停实体呼吸；.writing：书写态收起装饰层
      stage.classList.toggle('locked', s.locked);
      stage.classList.toggle('writing', !!s.station && s.mode === 'write');
    });
  }
}
