export const waiterService = {
  async request(type: string): Promise<{ message: string }> {
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    const messages: Record<string, string> = {
      waiter: 'Официант уже идёт к вам',
      cutlery: 'Приборы уже несут к вашему столу',
      bill: 'Официант подойдёт со счётом',
      help: 'Официант уже идёт помочь',
    };
    return { message: messages[type] ?? 'Официант уже идёт к вам' };
  },
};
