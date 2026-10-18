/**
 * echarts 按需引入：只注册实际使用的图表/组件/渲染器，降低打包体积。
 * 实际使用：折线图（历史曲线、风扇曲线）、grid、tooltip、graphic（曲线拖拽圆点）、legend（隐藏式）、canvas 渲染。
 */
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
    GridComponent,
    TooltipComponent,
    GraphicComponent,
    LegendComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { graphic } from "echarts/core";

echarts.use([
    LineChart,
    GridComponent,
    TooltipComponent,
    GraphicComponent,
    LegendComponent,
    CanvasRenderer,
]);

export { echarts, graphic };

// 仅类型导出（编译期擦除，不增加打包体积），供各图表模块使用
export type {
    ECharts,
    EChartsOption,
    SeriesOption,
    XAXisComponentOption,
    YAXisComponentOption,
    TooltipComponentOption,
    GridComponentOption,
    LegendComponentOption,
    GraphicComponentOption,
} from "echarts";
