// dsh-context-refiner — 客户端按钮 + 宿主侧的重置接口。
// 只有在宿主带 webServer 时才有接口；没有它时按钮仍会出现，只是极致档会报「宿主没有接口」。
export const name = 'dsh-context-refiner'

export function apply(ctx) {
  ctx.inject(['webServer'], (c) => {
    c.effect(() => {
      let stopped = false
      let dispose = null
      // 动态 import：模块顶层出错（缺依赖、Node 不支持 zstd）只会让接口不可用，
      // 不能把整个插件拖垮导致按钮也消失。
      import('./host/routes.js').then((mod) => {
        try {
          if (!stopped) dispose = mod.registerRefinerRoutes(c)
        } catch (error) {
          console.error('dsh-context-refiner: 接口注册失败（不影响按钮）：' + (error?.message ?? error))
        }
      }).catch((error) => {
        console.error('dsh-context-refiner: 宿主接口加载失败（不影响按钮）：' + (error?.message ?? error))
      })
      return () => {
        stopped = true
        try { if (dispose) dispose() } catch { /* best effort */ }
      }
    })
  })
}
