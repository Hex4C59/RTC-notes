document.querySelectorAll('[data-queue-demo]').forEach((demo) => {
  const arrivalsInput = demo.querySelector('[data-arrivals]');
  const initialArrivals = arrivalsInput.value;
  const sendLimit = Number(demo.dataset.sendCount);
  const stepMs = Number(demo.dataset.stepMs);
  const packetsElement = demo.querySelector('[data-packets]');
  const status = demo.querySelector('[data-step-result]');
  let packets = [];
  let nextPacket = 1;
  let steps = 0;
  let sentTotal = 0;

  function render() {
    demo.querySelector('[data-elapsed]').textContent = String(steps * stepMs);
    demo.querySelector('[data-queued]').textContent = String(packets.length);
    demo.querySelector('[data-sent-total]').textContent = String(sentTotal);
    const items = document.createDocumentFragment();
    if (packets.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'queue-empty';
      empty.textContent = '队列为空';
      items.append(empty);
    } else {
      packets.slice(0, 18).forEach((number) => {
        const item = document.createElement('li');
        item.textContent = `包 ${number}`;
        items.append(item);
      });
      if (packets.length > 18) {
        const remainder = document.createElement('li');
        remainder.className = 'queue-empty';
        remainder.textContent = `后面还有 ${packets.length - 18} 个包`;
        items.append(remainder);
      }
    }
    packetsElement.replaceChildren(items);
  }

  demo.querySelector('[data-step]').addEventListener('click', () => {
    const count = Number(arrivalsInput.value);
    const previousLength = packets.length;
    for (let i = 0; i < count; i += 1) packets.push(nextPacket++);
    const sent = Math.min(sendLimit, packets.length);
    packets.splice(0, sent);
    steps += 1;
    sentTotal += sent;
    const change = packets.length - previousLength;
    const comparison = change > 0 ? `增加 ${change} 个` : change < 0 ? `减少 ${-change} 个` : '数量不变';
    render();
    status.textContent = `第 ${steps} 步：加入 ${count} 个，发走 ${sent} 个，剩下 ${packets.length} 个；队列${comparison}。`;
  });

  arrivalsInput.addEventListener('change', () => {
    status.textContent = `后续每步加入 ${arrivalsInput.value} 个包。已排队的 ${packets.length} 个包仍在，点击“运行 ${stepMs} ms”查看变化。`;
  });

  demo.querySelector('[data-reset]').addEventListener('click', () => {
    packets = [];
    nextPacket = 1;
    steps = 0;
    sentTotal = 0;
    arrivalsInput.value = initialArrivals;
    render();
    status.textContent = `已重新开始。队列为空，每步新来 ${initialArrivals} 个包，最多发走 ${sendLimit} 个。`;
  });

  render();
});
