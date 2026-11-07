import Icon from '../components/Icon.jsx'
import './Author.css'

const sections = {
  education: {
    title: '学历',
    items: [{ when: '2021.09 – 2025.06', what: '吉林建筑大学 · 信息安全（本科）' }],
  },
  work: {
    title: '工作',
    items: [
      { when: '2025.06 – 2025.12', what: '小米移动互联网有限公司（北京） · C++ 研发工程师' },
      { when: '2025.03 – 2025.06', what: '小米移动互联网有限公司（北京） · C++ 研发工程师（实习）' },
    ],
  },
  opensource: {
    title: '开源项目',
    items: [
      {
        when: 'ACMDOG',
        what: '算法竞赛训练与题目管理平台，支持训练计划制定、题目分类管理和进度追踪。',
        link: 'https://www.acmdog.cn',
        linkText: 'acmdog.cn ↗',
      },
    ],
  },
  competitions: {
    title: '竞赛经历',
    groups: [
      {
        subtitle: 'ICPC / CCPC 区域赛 & 邀请赛',
        items: [
          { when: '2024 · 2025', what: 'CCPC 长春邀请赛', medal: '银牌', cls: 'silver' },
          { when: '2024', what: 'ICPC 沈阳区域赛' },
          { when: '2023', what: 'CCPC 哈尔滨区域赛' },
          { when: '2024', what: 'CCPC 东北邀请赛', medal: '铜牌', cls: 'bronze' },
          { when: '2023', what: 'CCPC 吉林省赛', medal: '铜牌', cls: 'bronze' },
        ],
      },
      {
        subtitle: '其他竞赛',
        items: [
          { when: '2023', what: '睿抗机器人开发者大赛（RAICOM）', medal: '全国三等奖', cls: 'bronze' },
          { when: '2023', what: '高教杯全国大学生数学建模竞赛', medal: '省级一等奖', cls: 'gold' },
          { when: '2023', what: '中国大学生计算机设计大赛', medal: '省级一等奖', cls: 'gold' },
          { when: '2022 · 2023 · 2024', what: '蓝桥杯全国软件和信息技术专业人才大赛', medal: '省级二等奖', cls: 'silver' },
          { when: '2022 · 2023', what: '团体程序设计天梯赛（GPLT）', medal: '省级三等奖', cls: 'bronze' },
        ],
      },
    ],
  },
  campus: {
    title: '校内经历与荣誉',
    items: [
      { when: '2023 – 2024', what: '吉林建筑大学 ACM 协会 · 会长' },
      { when: '2023', what: '吉林建筑大学图书馆世界图书日年度借阅之星' },
      { when: '2022', what: '吉林建筑大学抗疫先进个人' },
    ],
  },
}

export default function Author() {
  return (
    <div className="author-page">
      <section className="author-hero">
        <div className="author-avatar">
          <Icon name="dog" size={40} />
        </div>
        <h1>SZP</h1>
        <p className="author-sub">
          C++ 研发工程师 · 算法竞赛选手
          <br />
          算法竞赛训练与题目管理平台{' '}
          <em className="author-brand">ACMDOG</em> 作者
        </p>
      </section>

      <div className="container author-container">
        <section className="card author-section">
          <h2 className="author-section-title">学历</h2>
          {sections.education.items.map((it, i) => (
            <Entry key={i} {...it} />
          ))}
        </section>

        <section className="card author-section">
          <h2 className="author-section-title">工作</h2>
          {sections.work.items.map((it, i) => (
            <Entry key={i} {...it} />
          ))}
        </section>

        <section className="card author-section">
          <h2 className="author-section-title">开源项目</h2>
          {sections.opensource.items.map((it, i) => (
            <Entry key={i} {...it} />
          ))}
        </section>

        <section className="card author-section">
          <h2 className="author-section-title">竞赛经历</h2>
          {sections.competitions.groups.map((g, gi) => (
            <div key={gi}>
              <h3 className="author-subtitle">{g.subtitle}</h3>
              {g.items.map((it, i) => (
                <Entry key={i} {...it} />
              ))}
            </div>
          ))}
        </section>

        <section className="card author-section">
          <h2 className="author-section-title">校内经历与荣誉</h2>
          {sections.campus.items.map((it, i) => (
            <Entry key={i} {...it} />
          ))}
        </section>
      </div>
    </div>
  )
}

function Entry({ when, what, medal, cls, link, linkText }) {
  return (
    <div className="author-entry">
      <span className="author-when">{when}</span>
      <span className="author-what">
        {what}
        {medal && <span className={'medal medal-' + (cls || 'gold')}>{medal}</span>}
        {link && (
          <a className="author-link" href={link} target="_blank" rel="noreferrer">
            {linkText}
          </a>
        )}
      </span>
    </div>
  )
}
