import { effect } from '../../reactivity/src/effect';
import { reactive, shallowReactive } from '../../reactivity/src/reactive';
import { ShapeFlags } from '../../shared/shapeFlags';
import { resolveProps } from './componentProps';
import { createAppAPI } from './apiCreateApp';
import { Text, Comment, Fragment } from './vnode';
import type { Component, Render } from './component';
import type { VNode, VNodeArrayChildren } from './vnode';

export interface RendererOptions<HostElement = HTMLElement> {
  patchProp?(el: HostElement, key: string, prevValue, nextValue): void;
  createElement(type: string): HostElement;
  createComment(comment: string): any;
  setElementText(el, text): void;
  createText?(text: string): any;
  setText?(el: HostElement, text: string): void;
  remove?(el: HostElement): void;
  insert?(el: HostElement, parent: HostElement, anchor?: HostElement): void;
}

interface ExtraContainer {
  _vnode: VNode;
}

export type RootRenderFunction<HostElement = HTMLElement> = (
  vnode: VNode,
  container: HostElement & ExtraContainer
) => void;

export interface Renderer {
  render: RootRenderFunction;
  createApp: any;
}

type PatchFn = (n1: VNode | null, n2: VNode, container: HTMLElement) => void;

export function createRenderer(options: RendererOptions) {
  return baseCreateRenderer(options);
}

export function baseCreateRenderer(options: RendererOptions): Renderer {
  const {
    insert: hostInsert,
    remove: hostRemove,
    patchProp: hostPatchProp,
    createElement: hostCreateElement,
    createComment: hostCreateComment,
    createText: hostCreateText,
    setElementText: hostSetElementText,
    setText: hostSetText,
  } = options;
  const patch: PatchFn = (n1, n2, container) => {
    if (!n1) {
      // html element
      switch (n2.type) {
        case Text:
          processText(n1, n2, container);
          break;
        case Comment:
          processCommentNode(n1, n2, container);
          break;
        case Fragment:
          processFragment(n1, n2, container);
          break;
        default:
          if (typeof n2.type === 'string') {
            processElement(n1, n2, container);
          } else if (typeof n2.type === 'object') {
            // component
            processComponent(n1, n2, container);
          }
      }
    }
  };

  const patchChildren = (n1: VNode, n2: VNode, container: HTMLElement) => {
    const { shapeFlag: prevFlag } = n1;
    const { shapeFlag } = n2;
    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
      hostSetElementText((n2.el = n1.el), n2.children);
      if (prevFlag & ShapeFlags.ARRAY_CHILDREN) {
        (n1.children as VNodeArrayChildren).forEach(c => hostRemove(c.el));
      }
    } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      if (prevFlag & ShapeFlags.TEXT_CHILDREN) {
        hostSetElementText((n2.el = n1.el), '');
      } else if (prevFlag & ShapeFlags.ARRAY_CHILDREN) {
        (n1.children as VNodeArrayChildren).forEach(c => hostRemove(c.el));
      }
      (n2.children as VNodeArrayChildren).forEach(c =>
        hostInsert(c.el, container)
      );
    }
  };
  const patchProps = (
    el: HTMLElement,
    vnode: VNode,
    oldProps: any,
    newProps: any
  ) => {
    for (const key in oldProps) {
      if (!(key in newProps)) {
        hostPatchProp(el, key, oldProps[key], null);
      }
    }
    for (const key in newProps) {
      hostPatchProp(el, key, oldProps[key], newProps[key]);
    }
  };
  const mountElement = (vnode: VNode, container: HTMLElement) => {
    const { props, shapeFlag, type } = vnode;
    const el = (vnode.el = hostCreateElement(type as string));
    if (props) {
      for (const key in props) {
        // patch props
        hostPatchProp(el, key, null, props[key]);
      }
    }
    if (shapeFlag & ShapeFlags.TEXT_CHILDREN) {
      // children is text
      hostSetElementText(el, vnode.children);
    } else if (shapeFlag & ShapeFlags.ARRAY_CHILDREN) {
      // children is an array
      mountChildren(vnode.children as VNodeArrayChildren, el);
    }
    hostInsert(el, container);
  };
  const mountComponent = (vnode: VNode, container: HTMLElement) => {
    const componentOptions = vnode.type as Component;
    let { render, data, setup, props: propsOption } = componentOptions;
    const state = data ? reactive(data) : null;
    // distinguish between props and attrs
    const [props, attrs] = resolveProps(propsOption, vnode.props);
    // component instance
    const instance = {
      state,
      props: shallowReactive(props),
      isMounted: false,
      subTree: null,
    };
    // convert to setup
    const setupContext = { attrs };
    let setupState: object | null = null;
    const setupResult = setup(instance.props, setupContext);
    if (typeof setupResult === 'function') {
      // setup return render function
      if (render) console.error('setup 返回渲染函数, render选项将被忽略');
      else render = setupResult as Render;
    } else {
      // setup return reactive data
      setupState = setupResult;
    }
    instance.state = { ...state, setupState };
    const renderContext = new Proxy(instance, {
      get(t, k, r) {
        const { state, props } = t;
        if (k in state) {
          return state[k];
        } else if (k in props) {
          return props[k];
        } else {
          console.error('不存在');
        }
      },
      set(t, k, v, r) {
        const { state, props } = t;
        if (k in state) {
          state[k] = v;
        } else if (k in props) {
          console.warn('props is readonly');
        }
        return true;
      },
    });
    effect(() => {
      const subTree = render.call(renderContext, state);
      if (!instance.isMounted) {
        patch(null, subTree, container);
      } else {
        patch(instance.subTree, subTree, container);
      }
      instance.subTree = subTree;
    });
  };
  const mountChildren = (
    children: VNodeArrayChildren,
    container: HTMLElement
  ) => {
    children.forEach(child => {
      // recursive mount
      if (typeof child === 'string') {
        hostInsert(hostCreateText(child), container);
      } else {
        patch(null, child, container);
      }
    });
  };
  const patchElement = (n1: VNode, n2: VNode, container: HTMLElement) => {
    patchProps(n1.el, n2, n1.props, n2.props);
    patchChildren(n1, n2, container);
  };
  const patchComponent = (n1: VNode, n2: VNode, container: HTMLElement) => {};
  const processElement = (n1: VNode, n2: VNode, container: HTMLElement) => {
    if (!n1) {
      mountElement(n2, container);
    } else {
      patchElement(n1, n2, container);
    }
  };
  const processComponent = (n1: VNode, n2: VNode, container: HTMLElement) => {
    if (!n1) {
      mountComponent(n2, container);
    } else {
      patchComponent(n1, n2, container);
    }
  };
  const processText = (n1: VNode, n2: VNode, container: HTMLElement) => {
    if (!n1) {
      hostInsert((n2.el = hostCreateText(n2.children as string)), container);
    } else {
      const el = (n2.el = n1.el!);
      if (n1.children !== n2.children) {
        hostSetText(el, n2.children as string);
      }
    }
  };
  const processCommentNode = (n1: VNode, n2: VNode, container: HTMLElement) => {
    if (!n1) {
      hostInsert((n2.el = hostCreateComment(n2.children as string)), container);
    } else {
      n2.el = n1.el;
    }
  };
  const processFragment = (n1: VNode, n2: VNode, container: HTMLElement) => {
    if (!n1) {
      mountChildren(n2.children as VNodeArrayChildren, container);
    } else {
      patchChildren(n1, n2, container);
    }
  };
  const remove = (vnode: VNode) => {
    hostRemove(vnode.el);
  };
  const unmount = (vnode: VNode) => {
    remove(vnode);
  };
  const render: RootRenderFunction = (vnode, container) => {
    if (vnode === null) {
      if (container._vnode) {
        unmount(container._vnode);
      }
    } else {
      patch(container._vnode || null, vnode, container);
    }
  };

  return {
    render,
    createApp: createAppAPI(render),
  };
}
