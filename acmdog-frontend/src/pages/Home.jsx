import { Link } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import './Home.css'

const features = [
  {
    icon: 'problem',
    title: '海量题库',
    desc: '覆盖入门到竞赛级的丰富题目，支持多语言提交与在线评测。',
    cls: 'sec',
  },
  {
    icon: 'judge',
    title: '实时评测',
    desc: '提交即评测，毫秒级返回结果，支持流式反馈判题进度。',
    cls: 'share',
  },
  {
    icon: 'contest',
    title: '竞赛排位',
    desc: '组织在线竞赛，实时排行榜，还原真实比赛氛围。',
    cls: 'conc',
  },
  {
    icon: 'sandbox',
    title: '在线沙盒',
    desc: '无需本地环境，随时随地编写并运行代码验证思路。',
    cls: 'gen',
  },
]

export default function Home() {
  return (
    <div className="container home">
      <section className="hero">
        <img className="hero-logo" src="/logo.png" alt="ACMDOG" />
        <h1>ACMDOG</h1>
        <p className="tag">算法竞赛综合平台 · Algorithm Contest Platform</p>
        <p className="desc">
          集题库、评测、竞赛与在线编程于一体的现代化 OJ 平台，
          助你高效刷题、精进算法。
        </p>
        <div className="hero-actions">
          <Link to="/problems" className="btn btn-primary btn-lg">
            开始刷题
          </Link>
          <Link to="/contests" className="btn btn-outline btn-lg">
            查看竞赛
          </Link>
        </div>
      </section>

      <section className="features">
        {features.map((f) => (
          <div className="feature" key={f.title}>
            <div className={'feature-icon ' + f.cls}>
              <Icon name={f.icon} size={24} />
            </div>
            <h3>{f.title}</h3>
            <p>{f.desc}</p>
          </div>
        ))}
      </section>
    </div>
  )
}
