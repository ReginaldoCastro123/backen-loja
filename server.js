import express from "express";
import axios from "axios";
import cors from "cors";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import crypto from "crypto";


dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ==============================
// CRIAR PAGAMENTO PIX
// ==============================
app.post("/criar-pagamento", async (req, res) => {
  try {
    // 1. Recebendo todos os dados novos do seu site
    const { 
      produto, valor, envio, 
      nome, celular, cep, rua, numero, complemento, bairro, cidade, estado 
    } = req.body;

    const idempotencyKey = crypto.randomUUID();

    const response = await axios.post(
      "https://api.mercadopago.com/v1/payments",
      {
        transaction_amount: Number(valor),
        description: produto,
        payment_method_id: "pix",
        payer: {
          email: "cliente@email.com" // Pode deixar fixo se não quiser exigir e-mail do cliente na loja
        },
        notification_url: "https://backen-loja.onrender.com/webhook",
        
        // 2. Guardando TODOS os dados extras no Mercado Pago
        metadata: {
          cliente_nome: nome || "Não informado",
          cliente_celular: celular || "Não informado",
          cliente_cep: cep || "Não informado",
          cliente_rua: rua || "Não informado",
          cliente_numero: numero || "Não informado",
          cliente_complemento: complemento || "",
          cliente_bairro: bairro || "Não informado",
          cliente_cidade: cidade || "Não informado",
          cliente_estado: estado || "Não informado",
          tipo_envio: envio || "Não informado"
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.MP_TOKEN}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": idempotencyKey
        }
      }
    );

    const pagamento = response.data;
    res.json({
      qr_code: pagamento.point_of_interaction.transaction_data.qr_code,
      qr_code_base64: pagamento.point_of_interaction.transaction_data.qr_code_base64
    });
  } catch (error) {
    console.log("ERRO:", error.response?.data || error.message);
    res.status(500).json({
      erro: "Erro ao criar pagamento",
      detalhe: error.response?.data || error.message
    });
  }
});

// ==============================
// WEBHOOK MERCADO PAGO
// ==============================
app.post("/webhook", async (req, res) => {
  // Esse JSON.stringify ajuda a mostrar o objeto inteiro nos logs do Render
  console.log("CHEGOU ALGO NO WEBHOOK:", JSON.stringify(req.body, null, 2));

  try {
    // 1. Verificação de segurança: evita que o app "quebre" se o MP mandar um aviso vazio
    if (!req.body || !req.body.data || !req.body.data.id) {
      console.log("Aviso: Webhook recebido sem ID de pagamento. Ignorando...");
      return res.sendStatus(200);
    }

    const paymentId = req.body.data.id;
    console.log(`Buscando dados do pagamento ID: ${paymentId}...`);

    // 2. Consulta a API do Mercado Pago
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MP_TOKEN}`
        }
      }
    );

    const pagamento = response.data;
    console.log(`Status do Pagamento ${paymentId}: ${pagamento.status}`);

    // 3. Verifica se aprovou e tenta enviar o e-mail
    if (pagamento.status === "approved") {
      console.log("Pagamento aprovado! Iniciando disparo de e-mail...");
      
      // Resgatando todas as informações do metadata
      const dadosCliente = {
        nome: pagamento.metadata?.cliente_nome,
        celular: pagamento.metadata?.cliente_celular,
        cep: pagamento.metadata?.cliente_cep,
        rua: pagamento.metadata?.cliente_rua,
        numero: pagamento.metadata?.cliente_numero,
        complemento: pagamento.metadata?.cliente_complemento,
        bairro: pagamento.metadata?.cliente_bairro,
        cidade: pagamento.metadata?.cliente_cidade,
        estado: pagamento.metadata?.cliente_estado,
        envio: pagamento.metadata?.tipo_envio
      };

      await enviarEmail(
        pagamento.description,
        pagamento.transaction_amount,
        dadosCliente // Mandamos o "pacote" todo de uma vez
      );
      
      console.log("Função de e-mail executada sem erros!");
    }

    // 4. Sempre devolve 200 pro Mercado Pago parar de insistir
    res.sendStatus(200);
  } catch (error) {
    // Mostra o erro exato que deu, se falhar
    console.error("ERRO NO WEBHOOK:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// ==============================
// ENVIAR EMAIL (PLANO B - RESEND)
// ==============================
async function enviarEmail(produto, valor, cliente) {
  try {
    console.log("Conectando ao Resend (Rota anti-bloqueio do Render)...");

    // Montando o texto do e-mail bem organizado
    const textoEmail = `
✅ OBA! UMA NOVA VENDA FOI APROVADA!

📦 DETALHES DO PEDIDO
-----------------------------------
Produto: ${produto}
Valor: R$ ${valor}
Forma de Envio: ${cliente.envio}

👤 DADOS DO COMPRADOR
-----------------------------------
Nome: ${cliente.nome}
WhatsApp/Celular: ${cliente.celular}

🚚 ENDEREÇO DE ENTREGA
-----------------------------------
Rua: ${cliente.rua}, Nº ${cliente.numero}
Complemento: ${cliente.complemento}
Bairro: ${cliente.bairro}
Cidade/UF: ${cliente.cidade} - ${cliente.estado}
CEP: ${cliente.cep}

-----------------------------------
Acesse o seu painel para preparar o envio!
    `;

    const response = await axios.post(
      "https://api.resend.com/emails",
      {
        from: "Notificacao Loja <onboarding@resend.dev>", 
        to: "farmafacil35@gmail.com", 
        subject: `✅ Pedido Pago: ${produto} (R$ ${valor})`, // Coloquei o nome do produto no título do e-mail!
        text: textoEmail
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("E-mail enviado com sucesso via Resend! ID:", response.data.id);
    
  } catch (error) {
    console.error("ERRO GRAVE AO ENVIAR O E-MAIL (RESEND):", error.response?.data || error.message);
    throw error; 
  }
}
// ROTA PARA CALCULAR FRETE (FILTRADO APENAS CORREIOS)
app.post("/calcular-frete", async (req, res) => {
  try {
    const { cepDestino } = req.body;

    const response = await axios.post(
      "https://melhorenvio.com.br/api/v2/me/shipment/calculate",
      {
        from: { postal_code: "76913430" }, // Seu CEP de Ji-Paraná
        to: { postal_code: cepDestino },
        products: [
          { id: "produto", width: 15, height: 15, length: 15, weight: 0.5, insurance_value: 50, quantity: 1 }
        ]
      },
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${process.env.MELHOR_ENVIO_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    // FILTRO: Retorna apenas PAC (ID 1) e SEDEX (ID 2)
    const fretesFiltrados = response.data.filter(opcao => 
      opcao.id === 1 || opcao.id === 2 || opcao.id === "1" || opcao.id === "2"
    );

    res.json(fretesFiltrados);
  } catch (error) {
    console.error("Erro na API do Melhor Envio:", error.response?.data || error.message);
    res.status(500).json({ erro: "Erro ao calcular frete" });
  }
});

// ==============================
// INICIAR O SERVIDOR
// ==============================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}...`);
});






